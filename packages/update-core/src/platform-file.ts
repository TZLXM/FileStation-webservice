import { constants } from "node:fs";
import { open, FileHandle, lstat } from "node:fs/promises";
import path from "node:path";
import * as koffi from "koffi";
export interface FileIdentity {
  id: string;
  size: number;
  directory: boolean;
}
export interface BoundFile {
  identity(): Promise<FileIdentity>;
  read(offset: number, length: number): Promise<Buffer>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}
/** Injectable only at the OS boundary; production always uses the native implementation. */
export interface WindowsApi {
  create(
    path: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
  ): unknown;
  info(handle: unknown): {
    attributes: number;
    volume: number;
    indexHigh: number;
    indexLow: number;
    sizeHigh: number;
    sizeLow: number;
    links: number;
  };
  read(handle: unknown, offset: number, length: number): Buffer;
  write(handle: unknown, bytes: Buffer): number;
  close(handle: unknown): void;
}
let api: WindowsApi | undefined;
function winApi(): WindowsApi {
  if (api) return api;
  const dll = koffi.load("kernel32.dll");
  const create = dll.func(
    "void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
  );
  const info = dll.func(
    "int __stdcall GetFileInformationByHandle(void *handle, _Out_ uint8_t *info)",
  );
  const seek = dll.func(
    "int __stdcall SetFilePointerEx(void *handle, int64_t distance, void *position, uint32_t method)",
  );
  const read = dll.func(
    "int __stdcall ReadFile(void *handle, _Out_ uint8_t *bytes, uint32_t length, _Out_ uint32_t *count, void *overlapped)",
  );
  const write = dll.func(
    "int __stdcall WriteFile(void *handle, const uint8_t *bytes, uint32_t length, _Out_ uint32_t *count, void *overlapped)",
  );
  const close = dll.func("int __stdcall CloseHandle(void *handle)");
  const error = dll.func("uint32_t __stdcall GetLastError()");
  const check = (ok: unknown) => {
    if (!ok) throw new Error(`Win32 archive I/O error ${error()}`);
  };
  api = {
    create(p, a, s, d, f) {
      const h = create(p, a, s, null, d, f, null);
      if (!h || koffi.address(h) === 0xffffffffffffffffn)
        throw new Error(`Win32 archive open error ${error()}`);
      return h;
    },
    info(h) {
      // BY_HANDLE_FILE_INFORMATION: DWORD-aligned 52 bytes, including three FILETIMEs.
      const b = Buffer.alloc(52);
      check(info(h, b));
      return {
        attributes: b.readUInt32LE(0),
        volume: b.readUInt32LE(28),
        sizeHigh: b.readUInt32LE(32),
        sizeLow: b.readUInt32LE(36),
        links: b.readUInt32LE(40),
        indexHigh: b.readUInt32LE(44),
        indexLow: b.readUInt32LE(48),
      };
    },
    read(h, offset, length) {
      check(seek(h, BigInt(offset), null, 0));
      const b = Buffer.alloc(length);
      const count = [0];
      check(read(h, b, length, count, null));
      return b.subarray(0, count[0]);
    },
    write(h, b) {
      const count = [0];
      check(write(h, b, b.length, count, null));
      return count[0];
    },
    close(h) {
      check(close(h));
    },
  };
  return api;
}
const REPARSE = 0x00200000;
const BACKUP = 0x02000000;
function winInfo(
  native: WindowsApi,
  h: unknown,
  directory: boolean,
): FileIdentity {
  const i = native.info(h);
  if (
    i.attributes & 0x400 ||
    Boolean(i.attributes & 0x10) !== directory ||
    (!directory && i.links !== 1)
  )
    throw new Error("Archive reparse/type/hardlink rejected");
  const size = i.sizeHigh * 0x100000000 + i.sizeLow;
  if (!Number.isSafeInteger(size)) throw new Error("Archive size overflow");
  return { id: `${i.volume}:${i.indexHigh}:${i.indexLow}`, size, directory };
}
/** Deny write/delete sharing on the file and keep ancestor directories non-replaceable. */
export async function openWindowsFile(
  filename: string,
  output = false,
  native: WindowsApi = winApi(),
): Promise<BoundFile> {
  const absolute = path.win32.resolve(filename);
  if (!/^[A-Za-z]:\\/.test(absolute) || absolute.includes(":", 2))
    throw new Error("Only local drive paths supported");
  const handles: unknown[] = [];
  try {
    const root = path.win32.parse(absolute).root;
    const parts = path.win32.relative(root, absolute).split("\\");
    let parent = root;
    // Opening each component with OPEN_REPARSE_POINT while retaining the parent
    // prevents an ancestor replacement between validation and the final file open.
    for (const component of [null, ...parts.slice(0, -1)]) {
      if (component !== null) parent = path.win32.join(parent, component);
      const h = native.create(parent, 0x80, 1, 3, REPARSE | BACKUP);
      handles.push(h);
      winInfo(native, h, true);
    }
    const file = native.create(
      absolute,
      output ? 0x40000000 : 0x80000000,
      1,
      output ? 1 : 3,
      REPARSE,
    );
    handles.push(file);
    winInfo(native, file, false);
    let closed = false;
    const alive = () => {
      if (closed) throw new Error("Closed archive handle");
    };
    return {
      async identity() {
        alive();
        return winInfo(native, file, false);
      },
      async read(offset, length) {
        alive();
        return native.read(file, offset, length);
      },
      async write(b) {
        alive();
        let pos = 0;
        while (pos < b.length) {
          const count = native.write(file, b.subarray(pos));
          if (count <= 0) throw new Error("Short archive write");
          pos += count;
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const h of handles.reverse()) native.close(h);
      },
    };
  } catch (e) {
    for (const h of handles.reverse()) {
      try {
        native.close(h);
      } catch {}
    }
    throw e;
  }
}
async function posixFile(
  filename: string,
  output: boolean,
): Promise<BoundFile> {
  if (typeof constants.O_NOFOLLOW !== "number")
    throw new Error("Native O_NOFOLLOW unavailable");
  // Sources and stages must not traverse a pre-existing symlink ancestor.
  let cursor = path.parse(path.resolve(filename)).root;
  for (const part of path
    .relative(cursor, path.dirname(path.resolve(filename)))
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, part);
    const s = await lstat(cursor);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new Error("Symlink ancestor rejected");
  }
  const f: FileHandle = await open(
    filename,
    (output
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      : constants.O_RDONLY) | constants.O_NOFOLLOW,
    0o600,
  );
  const identity = async () => {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || !Number.isSafeInteger(s.size))
      throw new Error("Archive type/size rejected");
    return { id: `${s.dev}:${s.ino}`, size: s.size, directory: false };
  };
  try {
    await identity();
  } catch (e) {
    await f.close();
    throw e;
  }
  return {
    identity,
    async read(offset, length) {
      const b = Buffer.alloc(length);
      const r = await f.read(b, 0, length, offset);
      return b.subarray(0, r.bytesRead);
    },
    async write(b) {
      let p = 0;
      while (p < b.length) {
        const r = await f.write(b, p, b.length - p);
        if (!r.bytesWritten) throw new Error("Short archive write");
        p += r.bytesWritten;
      }
    },
    async close() {
      await f.close();
    },
  };
}
export function openBoundFile(
  filename: string,
  output = false,
): Promise<BoundFile> {
  return process.platform === "win32"
    ? openWindowsFile(filename, output)
    : posixFile(filename, output);
}
