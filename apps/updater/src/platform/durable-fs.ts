import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import * as koffi from "koffi";

const execFileAsync = promisify(execFile);
const FILE_FLAG_WRITE_THROUGH = 0x80000000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_APPEND_DATA = 0x0004;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const MOVEFILE_REPLACE_EXISTING = 0x1;
const MOVEFILE_WRITE_THROUGH = 0x8;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

export interface DurableStat {
  size: number;
  mode: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DurableStatFs {
  availableBytes: number;
  capacityBytes: number;
}

export interface WriteOptions {
  mode?: number;
}

export interface RenameOptions {
  replace?: boolean;
}

/**
 * Narrow filesystem port used by update primitives. The production
 * implementation uses POSIX fsync or native Win32 write-through handles.
 */
export interface DurableFileSystem {
  readonly kind: "posix-sync" | "windows-write-through";
  ensurePrivateDirectory(directory: string, mode?: number): Promise<void>;
  ensurePrivateFile(filename: string, mode?: number): Promise<void>;
  readFile(filename: string): Promise<Buffer>;
  writeAtomic(
    filename: string,
    bytes: Buffer,
    options?: WriteOptions,
  ): Promise<void>;
  append(
    filename: string,
    bytes: Buffer,
    options?: WriteOptions & { create?: boolean },
  ): Promise<void>;
  createExclusive(
    filename: string,
    bytes: Buffer,
    options?: WriteOptions,
  ): Promise<void>;
  truncate(filename: string, size: number): Promise<void>;
  rename(
    source: string,
    target: string,
    options?: RenameOptions,
  ): Promise<void>;
  unlink(filename: string): Promise<void>;
  exists(filename: string): Promise<boolean>;
  stat(filename: string): Promise<DurableStat>;
  lstat(filename: string): Promise<DurableStat>;
  readlink(filename: string): Promise<string>;
  realpath(filename: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  symlink(target: string, link: string): Promise<void>;
  createJunction(target: string, link: string): Promise<void>;
  fsyncDirectory(directory: string): Promise<void>;
  statfs(candidate: string): Promise<DurableStatFs>;
  protect(filename: string, directory: boolean): Promise<void>;
}

interface DurableStatLike {
  size: number;
  mode: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function durableStat(value: DurableStatLike): DurableStat {
  return {
    size: value.size,
    mode: value.mode,
    dev: value.dev,
    ino: value.ino,
    isFile: () => value.isFile(),
    isDirectory: () => value.isDirectory(),
    isSymbolicLink: () => value.isSymbolicLink(),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export interface WindowsNativeApi {
  create(
    filename: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
  ): unknown;
  write(handle: unknown, bytes: Buffer): number;
  flush(handle: unknown): void;
  close(handle: unknown): void;
  move(source: string, target: string, flags: number): void;
  volumePath(filename: string): string;
  volumeSerial(volumePath: string): number;
  volumeGuid(volumePath: string): string;
}

export interface WindowsDiagnostics {
  flushFileBuffers: number;
  writeThroughFile: number;
  writeThroughRename: number;
  aclProtections: number;
}

interface WindowsBackend {
  api: WindowsNativeApi;
  diagnostics: WindowsDiagnostics;
}

function winError(message: string, code: number): Error {
  return Object.assign(new Error(`${message} (Win32 error ${code})`), {
    code: code === 80 || code === 183 ? "EEXIST" : code,
    win32Code: code,
  });
}

export function createWindowsNativeApi(): WindowsNativeApi {
  const dll = koffi.load("kernel32.dll");
  const createFile = dll.func(
    "void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
  );
  const writeFile = dll.func(
    "int __stdcall WriteFile(void *handle, const uint8_t *bytes, uint32_t length, _Out_ uint32_t *count, void *overlapped)",
  );
  const flushFile = dll.func(
    "int __stdcall FlushFileBuffers(void *handle)",
  );
  const closeHandle = dll.func("int __stdcall CloseHandle(void *handle)");
  const moveFileEx = dll.func(
    "int __stdcall MoveFileExW(const char16_t *source, const char16_t *target, uint32_t flags)",
  );
  const getLastError = dll.func(
    "uint32_t __stdcall GetLastError()",
  );
  const getVolumePathName = dll.func(
    "int __stdcall GetVolumePathNameW(const char16_t *filename, _Out_ uint16_t *volumePath, uint32_t length)",
  );
  const getVolumeName = dll.func("int __stdcall GetVolumeNameForVolumeMountPointW(const char16_t *mount, _Out_ uint16_t *name, uint32_t length)");
  const getVolumeInformation = dll.func(
    "int __stdcall GetVolumeInformationW(const char16_t *root, void *label, uint32_t labelLength, _Out_ uint32_t *serial, void *maxComponent, void *flags, void *filesystem, uint32_t filesystemLength)",
  );

  const checkHandle = (handle: unknown): unknown => {
    if (!handle || koffi.address(handle) === INVALID_HANDLE_VALUE)
      throw winError("Win32 open failed", getLastError());
    return handle;
  };

  return {
    create(filename, access, share, disposition, flags) {
      return checkHandle(
        createFile(
          path.win32.resolve(filename),
          access,
          share,
          null,
          disposition,
          flags,
          null,
        ),
      );
    },
    write(handle, bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        const count = [0];
        if (!writeFile(handle, bytes.subarray(offset), bytes.length - offset, count, null))
          throw winError("Win32 write failed", getLastError());
        if (count[0] <= 0) throw winError("Win32 short write", 0);
        offset += count[0];
      }
      return offset;
    },
    flush(handle) {
      if (!flushFile(handle))
        throw winError("FlushFileBuffers failed", getLastError());
    },
    close(handle) {
      if (!closeHandle(handle))
        throw winError("CloseHandle failed", getLastError());
    },
    move(source, target, flags) {
      if (
        !moveFileEx(
          path.win32.resolve(source),
          path.win32.resolve(target),
          flags,
        )
      )
        throw winError("MoveFileExW failed", getLastError());
    },
    volumePath(filename) {
      const output = Buffer.alloc(32768 * 2);
      if (!getVolumePathName(path.win32.resolve(filename), output, 32768))
        throw winError("GetVolumePathNameW failed", getLastError());
      let end = output.length;
      for (let offset = 0; offset < output.length; offset += 2) {
        if (output.readUInt16LE(offset) === 0) {
          end = offset;
          break;
        }
      }
      return output.subarray(0, end).toString("utf16le");
    },
    volumeGuid(volumePath) {
      const output = Buffer.alloc(1024);
      if (!getVolumeName(volumePath, output, 512)) throw winError("GetVolumeNameForVolumeMountPointW failed", getLastError());
      return output.toString("utf16le").split("\0")[0].toLowerCase();
    },
    volumeSerial(volumePath) {
      // Koffi writes into the array supplied for the serial output pointer.
      const holder = [0];
      if (
        !getVolumeInformation(
          volumePath,
          null,
          0,
          holder,
          null,
          null,
          null,
          0,
        )
      )
        throw winError("GetVolumeInformationW failed", getLastError());
      return holder[0] >>> 0;
    },
  };
}

function newWindowsBackend(): WindowsBackend {
  return {
    api: createWindowsNativeApi(),
    diagnostics: {
      flushFileBuffers: 0,
      writeThroughFile: 0,
      writeThroughRename: 0,
      aclProtections: 0,
    },
  };
}

export class NodeDurableFileSystem implements DurableFileSystem {
  readonly kind: "posix-sync" | "windows-write-through";
  protected readonly windows?: WindowsBackend;
  private currentUserSid?: string;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.kind =
      platform === "win32" ? "windows-write-through" : "posix-sync";
    if (platform === "win32") this.windows = newWindowsBackend();
  }

  async ensurePrivateDirectory(directory: string, mode = 0o700): Promise<void> {
    await mkdir(directory, { recursive: true, mode });
    await this.fsyncDirectory(path.dirname(directory));
    await this.protect(directory, true);
  }

  async ensurePrivateFile(filename: string, mode = 0o600): Promise<void> {
    if (await this.exists(filename)) {
      await this.protect(filename, false);
      return;
    }
    await this.createExclusive(filename, Buffer.alloc(0), { mode });
  }

  async readFile(filename: string): Promise<Buffer> {
    return readFile(filename);
  }

  async writeAtomic(
    filename: string,
    bytes: Buffer,
    options: WriteOptions = {},
  ): Promise<void> {
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(filename)}.tmp-${randomUUID()}`,
    );
    try {
      await this.createExclusive(temporary, bytes, {
        mode: options.mode ?? 0o600,
      });
      await this.rename(temporary, filename, { replace: true });
    } catch (error) {
      await this.unlink(temporary).catch((cleanupError) => {
        if (!isNotFound(cleanupError)) throw cleanupError;
      });
      throw error;
    }
  }

  protected async flushFile(_filename: string, flush: () => Promise<void>): Promise<void> {
    await flush();
  }

  async append(
    filename: string,
    bytes: Buffer,
    options: WriteOptions & { create?: boolean } = {},
  ): Promise<void> {
    const create = options.create ?? true;
    const mode = options.mode ?? 0o600;
    const existed = await this.exists(filename);
    if (!create && !existed)
      throw Object.assign(new Error(`File does not exist: ${filename}`), {
        code: "ENOENT",
      });
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (this.windows) {
      const handle = this.windows.api.create(
        filename,
        FILE_APPEND_DATA,
        0,
        create ? OPEN_ALWAYS : OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      );
      try {
        this.windows.diagnostics.writeThroughFile++;
        this.windows.api.write(handle, bytes);
        this.windows.diagnostics.flushFileBuffers++;
        await this.flushFile(filename, async () => { this.windows!.api.flush(handle); });
      } finally {
        this.windows.api.close(handle);
      }
    } else {
      const handle = await open(
        filename,
        constants.O_WRONLY |
          constants.O_APPEND |
          (create ? constants.O_CREAT : 0),
        mode,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (result.bytesWritten <= 0)
            throw new Error("Short durable append");
          offset += result.bytesWritten;
        }
        await this.flushFile(filename, () => handle.sync());
      } finally {
        await handle.close();
      }
      await chmod(filename, mode);
    }
    if (!existed) await this.fsyncDirectory(path.dirname(filename));
    await this.protect(filename, false);
  }

  async createExclusive(
    filename: string,
    bytes: Buffer,
    options: WriteOptions = {},
  ): Promise<void> {
    const mode = options.mode ?? 0o600;
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (this.windows) {
      const handle = this.windows.api.create(
        filename,
        GENERIC_WRITE,
        0,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      );
      try {
        this.windows.diagnostics.writeThroughFile++;
        this.windows.api.write(handle, bytes);
        this.windows.diagnostics.flushFileBuffers++;
        await this.flushFile(filename, async () => { this.windows!.api.flush(handle); });
      } finally {
        this.windows.api.close(handle);
      }
    } else {
      const handle = await open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (result.bytesWritten <= 0)
            throw new Error("Short durable write");
          offset += result.bytesWritten;
        }
        await this.flushFile(filename, () => handle.sync());
      } finally {
        await handle.close();
      }
      await chmod(filename, mode);
    }
    await this.fsyncDirectory(path.dirname(filename));
    await this.protect(filename, false);
  }

  async truncate(filename: string, size: number): Promise<void> {
    if (this.windows) {
      // The journal only truncates a torn tail. Rewriting the retained prefix
      // through the write-through path keeps Windows on the explicit API.
      const handle = await open(filename, "r");
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(size);
        const result = await handle.read(bytes, 0, size, 0);
        bytes = bytes.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
      await this.writeAtomic(filename, bytes, { mode: 0o600 });
    } else {
      const handle = await open(filename, "r+");
      try {
        await handle.truncate(size);
        await this.flushFile(filename, () => handle.sync());
      } finally {
        await handle.close();
      }
    }
  }

  async rename(
    source: string,
    target: string,
    options: RenameOptions = {},
  ): Promise<void> {
    if (!options.replace && (await this.exists(target))) {
      throw Object.assign(new Error(`Destination exists: ${target}`), {
        code: "EEXIST",
      });
    }
    if (this.windows) {
      const flags =
        MOVEFILE_WRITE_THROUGH |
        (options.replace ? MOVEFILE_REPLACE_EXISTING : 0);
      this.windows.diagnostics.writeThroughRename++;
      this.windows.api.move(source, target, flags);
    } else {
      await rename(source, target);
    }
    await this.fsyncDirectory(path.dirname(source));
    if (path.dirname(target) !== path.dirname(source))
      await this.fsyncDirectory(path.dirname(target));
  }

  async unlink(filename: string): Promise<void> {
    await unlink(filename);
    await this.fsyncDirectory(path.dirname(filename));
  }

  async exists(filename: string): Promise<boolean> {
    try {
      await lstat(filename);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async stat(filename: string): Promise<DurableStat> {
    return durableStat(await stat(filename));
  }

  async lstat(filename: string): Promise<DurableStat> {
    return durableStat(await lstat(filename));
  }

  async readlink(filename: string): Promise<string> {
    return readlink(filename);
  }

  async realpath(filename: string): Promise<string> {
    return realpath(filename);
  }

  async readdir(directory: string): Promise<string[]> {
    return readdir(directory);
  }

  async symlink(target: string, link: string): Promise<void> {
    await symlink(target, link, "dir");
    await this.fsyncDirectory(path.dirname(link));
  }

  async createJunction(target: string, link: string): Promise<void> {
    if (!this.windows) throw new Error("Windows junction requires win32");
    await symlink(path.win32.resolve(target), link, "junction");
    await this.fsyncDirectory(path.dirname(link));
  }

  async fsyncDirectory(directory: string): Promise<void> {
    if (this.windows) {
      let handle: unknown;
      try {
        handle = this.windows.api.create(
          directory,
          FILE_READ_ATTRIBUTES | GENERIC_WRITE,
          7,
          OPEN_EXISTING,
          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_WRITE_THROUGH,
        );
        this.windows.diagnostics.flushFileBuffers++;
        this.windows.api.flush(handle);
      } catch (error) {
        const code =
          typeof error === "object" && error && "code" in error
            ? Number((error as { code: unknown }).code)
            : 0;
        // MoveFileExW's WRITE_THROUGH flag is the authoritative directory
        // rename boundary. CreateDirectoryW has no separate fsync contract.
        if (code !== 5 && code !== 6 && code !== 87) throw error;
      } finally {
        if (handle) this.windows.api.close(handle);
      }
      return;
    }
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async statfs(candidate: string): Promise<DurableStatFs> {
    let cursor = path.resolve(candidate);
    while (!(await this.exists(cursor))) {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor: ${candidate}`);
      cursor = parent;
    }
    const value = await statfs(cursor);
    const availableBytes = Number(value.bavail) * Number(value.bsize);
    const capacityBytes = Number(value.blocks) * Number(value.bsize);
    if (
      !Number.isSafeInteger(availableBytes) ||
      !Number.isSafeInteger(capacityBytes)
    )
      throw new Error("Filesystem space exceeds JavaScript safe integers");
    return { availableBytes, capacityBytes };
  }

  async protect(filename: string, directory: boolean): Promise<void> {
    if (!this.windows) {
      await chmod(filename, directory ? 0o700 : 0o600);
      return;
    }
    if (!this.currentUserSid) {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        { windowsHide: true },
      );
      const sid = stdout.trim();
      if (!/^S-\d+(?:-\d+)+$/i.test(sid))
        throw new Error("Unable to determine current Windows user SID");
      this.currentUserSid = sid;
    }
    // Replace the complete DACL; /grant:r alone leaves unrelated explicit ACEs.
    const escaped = filename.replace(/'/g, "''");
    const inheritance = directory ? "ContainerInherit, ObjectInherit" : "None";
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$acl = New-Object System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}`,
      "$acl.SetAccessRuleProtection($true, $false)",
      ...[...new Set([this.currentUserSid, "S-1-5-18", "S-1-5-32-544"])].map(sid =>
        `$sid = New-Object System.Security.Principal.SecurityIdentifier('${sid}'); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow'); $acl.AddAccessRule($rule)`),
      `[System.IO.${directory ? 'Directory' : 'File'}]::SetAccessControl('${escaped}', $acl)`,
      `$actual = [System.IO.${directory ? 'Directory' : 'File'}]::GetAccessControl('${escaped}')`,
      `$expected = @('${this.currentUserSid}', 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique`,
      "$rules = @($actual.Access)",
      "if (!$actual.AreAccessRulesProtected -or $rules.Count -ne $expected.Count) { throw 'Unexpected DACL' }",
      "foreach ($rule in $rules) { if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $expected -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Unexpected ACE' } }",
    ].join("; ");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
    this.windows.diagnostics.aclProtections++;
  }
}

export class WindowsDurableFileSystem extends NodeDurableFileSystem {
  constructor() {
    super("win32");
  }

  get diagnostics(): WindowsDiagnostics {
    if (!this.windows) throw new Error("Windows backend unavailable");
    return this.windows.diagnostics;
  }
}
