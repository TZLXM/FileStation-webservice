import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createInflateRaw } from "node:zlib";
import { BoundFile, FileIdentity, openBoundFile } from "./platform-file";
export interface VerifiedArchiveHandle {
  readonly size: number;
  readonly sha256: string;
  close(): Promise<void>;
}
export interface ArchiveLimits {
  format: "zip" | "tar.gz";
  version: string;
  platform: string;
  unpackedSize: number;
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxRatio?: number;
}
interface Limits extends Required<ArchiveLimits> {}
export interface ArchiveMember {
  readonly path: string;
  readonly size: number;
  readonly directory: boolean;
}
export interface VerifiedArchivePlan {
  readonly members: readonly ArchiveMember[];
  readonly unpackedSize: number;
}
interface State {
  file: BoundFile;
  identity: FileIdentity;
  digest: string;
  busy: boolean;
  closed: boolean;
}
const handles = new WeakMap<VerifiedArchiveHandle, State>();
const plans = new WeakMap<
  VerifiedArchivePlan,
  {
    handle: VerifiedArchiveHandle;
    limits: Limits;
    fingerprint: string;
  }
>();
const CHUNK = 64 * 1024;
const HARD_MAX_ARCHIVE = 2 * 1024 ** 3;
function fail(message: string): never {
  throw new Error(`Unsafe archive: ${message}`);
}
async function hash(file: BoundFile, size: number): Promise<string> {
  const h = createHash("sha256");
  for (let pos = 0; pos < size; ) {
    const b = await file.read(pos, Math.min(CHUNK, size - pos));
    if (!b.length) fail("short read");
    h.update(b);
    pos += b.length;
  }
  return h.digest("hex");
}
function state(handle: VerifiedArchiveHandle): State {
  const s = handles.get(handle);
  if (!s || s.closed) fail("unknown/closed handle");
  return s;
}
async function unchanged(s: State): Promise<void> {
  const i = await s.file.identity();
  if (
    i.id !== s.identity.id ||
    i.size !== s.identity.size ||
    (await hash(s.file, i.size)) !== s.digest
  )
    fail("source identity/size/hash changed");
}
export async function openVerifiedArchive(
  filename: string,
  digest: string,
): Promise<VerifiedArchiveHandle> {
  if (!/^[a-f0-9]{64}$/.test(digest)) fail("invalid SHA256");
  const file = await openBoundFile(filename);
  try {
    const identity = await file.identity();
    if (identity.size < 1 || identity.size > HARD_MAX_ARCHIVE)
      fail("compressed size");
    const s: State = { file, identity, digest, busy: false, closed: false };
    await unchanged(s);
    const handle: VerifiedArchiveHandle = Object.freeze({
      size: identity.size,
      sha256: digest,
      async close() {
        if (s.busy) fail("handle in use");
        if (!s.closed) {
          s.closed = true;
          await file.close();
        }
      },
    });
    handles.set(handle, s);
    return handle;
  } catch (e) {
    await file.close();
    throw e;
  }
}
function budget(raw: ArchiveLimits): Limits {
  const l: Limits = {
    maxArchiveBytes: 1024 ** 3,
    maxEntries: 100000,
    maxFileBytes: 512 * 1024 ** 2,
    maxTotalBytes: 4 * 1024 ** 3,
    maxRatio: 200,
    ...raw,
  };
  if (
    !["zip", "tar.gz"].includes(l.format) ||
    !/^\d+\.\d+\.\d+$/.test(l.version) ||
    !["windows-x64", "linux-x64"].includes(l.platform) ||
    (l.format === "zip") !== (l.platform === "windows-x64")
  )
    fail("format/platform/version");
  for (const k of [
    "unpackedSize",
    "maxArchiveBytes",
    "maxEntries",
    "maxFileBytes",
    "maxTotalBytes",
  ] as const)
    if (!Number.isSafeInteger(l[k]) || l[k] < 1) fail(`invalid ${k}`);
  if (
    l.maxArchiveBytes > HARD_MAX_ARCHIVE ||
    l.maxEntries > 1000000 ||
    l.maxTotalBytes > 16 * 1024 ** 3 ||
    !Number.isFinite(l.maxRatio) ||
    l.maxRatio <= 0 ||
    l.maxRatio > 1000
  )
    fail("resource policy");
  return Object.freeze(l);
}
async function exact(
  s: State,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (offset < 0 || length < 0 || offset + length > s.identity.size)
    fail("record bounds");
  const b = await s.file.read(offset, length);
  if (b.length !== length) fail("short record");
  return b;
}
async function* source(
  s: State,
  start = 0,
  length = s.identity.size,
): AsyncGenerator<Buffer> {
  for (let p = start; p < start + length; ) {
    const b = await exact(s, p, Math.min(CHUNK, start + length - p));
    p += b.length;
    yield b;
  }
}
class Counter {
  members: ArchiveMember[] = [];
  total = 0;
  private names = new Map<string, string>();
  private types = new Map<string, boolean>();
  private explicit = new Set<string>();
  private rootSeen = false;
  constructor(
    readonly limits: Limits,
    readonly compressed: number,
  ) {
    if (compressed > limits.maxArchiveBytes) fail("compressed size limit");
  }
  add(
    name: string,
    size: number,
    directory: boolean,
  ): ArchiveMember | undefined {
    if (
      !name ||
      name.length > 4096 ||
      /[^\x20-\x7e]|[\\:%]/.test(name) ||
      name.startsWith("/")
    )
      fail("member path encoding");
    if (!directory && name.endsWith("/")) fail("file with trailing slash");
    const parts = name.replace(/\/$/, "").split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
    )
      fail("member path component");
    const root = `filestation-v${this.limits.version}-${this.limits.platform === "windows-x64" ? "win" : "linux"}-x64`;
    if (parts.shift() !== root) fail("publisher root");
    if (!parts.length) {
      if (!directory || size !== 0 || this.rootSeen)
        fail("invalid or duplicate root directory");
      this.rootSeen = true;
      return;
    }
    if (
      ["data", "updater"].includes(parts[0].toLowerCase()) ||
      parts.some((p) => /^\.env(?:\.|$)/i.test(p))
    )
      fail("reserved install path");
    const relative = parts.join("/");
    if (this.explicit.has(relative.toLowerCase())) fail("duplicate member");
    this.explicit.add(relative.toLowerCase());
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/"),
        key = p.toLowerCase(),
        dir = i < parts.length || directory;
      if (this.names.has(key) && this.names.get(key) !== p)
        fail("case collision");
      if (this.types.has(key) && this.types.get(key) !== dir)
        fail("file/directory collision");
      this.names.set(key, p);
      this.types.set(key, dir);
    }
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > this.limits.maxFileBytes ||
      (directory && size !== 0)
    )
      fail("member size limit");
    this.total += size;
    if (
      this.total > this.limits.maxTotalBytes ||
      this.total > this.limits.unpackedSize ||
      this.total > this.compressed * this.limits.maxRatio
    )
      fail("unpacked size/ratio limit");
    const m = Object.freeze({ path: relative, size, directory });
    this.members.push(m);
    if (this.members.length > this.limits.maxEntries) fail("entry count");
    return m;
  }
  finish(): void {
    if (this.total !== this.limits.unpackedSize) fail("unpacked size mismatch");
    for (const prefix of [
      "apps/server/dist/",
      "apps/web/dist-root/",
      "apps/web/dist-fs/",
      "packages/shared/dist/",
      "node_modules/",
    ])
      if (!this.members.some((m) => !m.directory && m.path.startsWith(prefix)))
        fail("missing runtime layout");
  }
}
type Sink = (
  member: ArchiveMember,
  chunks: AsyncIterable<Buffer>,
) => Promise<void>;
async function discard(chunks: AsyncIterable<Buffer>): Promise<void> {
  for await (const _ of chunks) {
    /* validate while draining */
  }
}
const utf8 = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);
function crcUpdate(crc: number, b: Buffer): number {
  for (const x of b) {
    crc ^= x;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc;
}
async function zipWalk(s: State, c: Counter, sink?: Sink): Promise<void> {
  const size = s.identity.size;
  if (size < 22) fail("ZIP footer");
  const end = await exact(s, size - 22, 22);
  if (
    end.readUInt32LE(0) !== 0x06054b50 ||
    end.readUInt16LE(4) !== 0 ||
    end.readUInt16LE(6) !== 0 ||
    end.readUInt16LE(8) !== end.readUInt16LE(10) ||
    end.readUInt16LE(20) !== 0
  )
    fail("ZIP multidisk/comment/ZIP64 unsupported");
  const count = end.readUInt16LE(10),
    centralSize = end.readUInt32LE(12),
    centralOffset = end.readUInt32LE(16);
  if (
    count > c.limits.maxEntries ||
    count === 0 ||
    centralOffset + centralSize !== size - 22
  )
    fail("ZIP directory bounds");
  let pos = centralOffset,
    localPos = 0;
  const consumed = createHash("sha256");
  const centralRecords: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const d = await exact(s, pos, 46);
    if (d.readUInt32LE(0) !== 0x02014b50) fail("ZIP central header");
    const flags = d.readUInt16LE(8),
      method = d.readUInt16LE(10),
      crc = d.readUInt32LE(16),
      packed = d.readUInt32LE(20),
      unpacked = d.readUInt32LE(24),
      nl = d.readUInt16LE(28),
      extra = d.readUInt16LE(30),
      comment = d.readUInt16LE(32),
      offset = d.readUInt32LE(42);
    if (
      (flags !== 0 && flags !== 0x800) ||
      (method !== 0 && method !== 8) ||
      extra ||
      comment ||
      d.readUInt16LE(34) !== 0 ||
      !nl ||
      nl > 4096 ||
      offset !== localPos ||
      unpacked === 0xffffffff ||
      packed === 0xffffffff ||
      offset === 0xffffffff
    )
      fail("ZIP flags/type/bounds");
    const raw = await exact(s, pos + 46, nl);
    centralRecords.push(d, raw);
    const name = utf8(raw);
    pos += 46 + nl;
    const mode = (d.readUInt32LE(38) >>> 16) & 0o170000;
    const directory = name.endsWith("/");
    if (mode !== 0 && mode !== (directory ? 0o040000 : 0o100000))
      fail("ZIP special member");
    if ((d.readUInt32LE(38) & 0x10) !== 0 && !directory)
      fail("ZIP directory attribute mismatch");
    const m = c.add(name, unpacked, directory);
    if (unpacked > Math.max(1, packed) * c.limits.maxRatio)
      fail("ZIP member compression ratio");
    const h = await exact(s, offset, 30);
    if (
      h.readUInt32LE(0) !== 0x04034b50 ||
      h.readUInt16LE(6) !== flags ||
      h.readUInt16LE(8) !== method ||
      h.readUInt32LE(14) !== crc ||
      h.readUInt32LE(18) !== packed ||
      h.readUInt32LE(22) !== unpacked ||
      h.readUInt16LE(26) !== nl ||
      h.readUInt16LE(28) !== 0
    )
      fail("ZIP local metadata mismatch");
    const localName = await exact(s, offset + 30, nl);
    if (!localName.equals(raw)) fail("ZIP name mismatch");
    consumed.update(h);
    consumed.update(localName);
    const dataOffset = offset + 30 + nl;
    localPos = dataOffset + packed;
    if (localPos > centralOffset) fail("ZIP overlap");
    const chunks = async function* () {
      let observed = 0,
        checksum = 0xffffffff;
      const compressed = async function* () {
        for await (const b of source(s, dataOffset, packed)) {
          consumed.update(b);
          yield b;
        }
      };
      const input = Readable.from(compressed());
      const inflate = method === 8 ? createInflateRaw() : undefined;
      const stream = inflate ? input.pipe(inflate) : input;
      input.on("error", (e) => stream.destroy(e));
      try {
        for await (const chunk of stream) {
          const b = Buffer.from(chunk);
          observed += b.length;
          if (observed > unpacked || observed > c.limits.maxFileBytes)
            fail("ZIP expanded size");
          checksum = crcUpdate(checksum, b);
          yield b;
        }
        if (
          observed !== unpacked ||
          (checksum ^ 0xffffffff) >>> 0 !== crc ||
          (inflate && inflate.bytesWritten !== packed)
        )
          fail("ZIP CRC/size mismatch");
      } finally {
        input.destroy();
        inflate?.destroy();
      }
    };
    if (m && sink) await sink(m, chunks());
    else await discard(chunks());
  }
  if (pos !== size - 22 || localPos !== centralOffset)
    fail("ZIP unreferenced bytes");
  for (const b of centralRecords) consumed.update(b);
  consumed.update(end);
  if (consumed.digest("hex") !== s.digest)
    fail("ZIP consumed bytes hash mismatch");
}
class Cursor {
  private iterator: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  private done = false;
  private observed = 0;
  constructor(
    stream: AsyncIterable<Buffer>,
    readonly max: number,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async take(n: number, allowEof = false): Promise<Buffer> {
    const parts: Buffer[] = [];
    let left = n;
    while (left) {
      if (!this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) {
          this.done = true;
          if (allowEof && left === n) return Buffer.alloc(0);
          fail("truncated tar");
        }
        this.pending = Buffer.from(next.value);
        this.observed += this.pending.length;
        if (this.observed > this.max) fail("tar decompression budget");
      }
      const size = Math.min(left, this.pending.length);
      parts.push(this.pending.subarray(0, size));
      this.pending = this.pending.subarray(size);
      left -= size;
    }
    return Buffer.concat(parts, n);
  }
  async eof(): Promise<void> {
    if (this.pending.length) fail("trailing tar bytes");
    if (!this.done) {
      const r = await this.iterator.next();
      if (!r.done) fail("trailing tar bytes");
    }
  }
}
function tarText(b: Buffer): string {
  const nul = b.indexOf(0);
  if (nul >= 0 && b.subarray(nul).some((x) => x !== 0))
    fail("tar string padding");
  return utf8(nul < 0 ? b : b.subarray(0, nul));
}
function octal(b: Buffer): number {
  const value = b
    .toString("ascii")
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (!/^[0-7]+$/.test(value)) fail("tar numeric field");
  const n = parseInt(value, 8);
  if (!Number.isSafeInteger(n)) fail("tar numeric overflow");
  return n;
}
async function tarWalk(s: State, c: Counter, sink?: Sink): Promise<void> {
  const consumed = createHash("sha256");
  const compressed = async function* () {
    for await (const b of source(s)) {
      consumed.update(b);
      yield b;
    }
  };
  const input = Readable.from(compressed());
  const gzip = createGunzip();
  const stream = input.pipe(gzip);
  input.on("error", (e) => gzip.destroy(e));
  const cursor = new Cursor(
    stream,
    Math.min(c.limits.maxTotalBytes, c.limits.unpackedSize) +
      (c.limits.maxEntries + 2) * 1024,
  );
  let count = 0;
  try {
    for (;;) {
      const h = await cursor.take(512);
      if (h.every((x) => x === 0)) {
        const tail = await cursor.take(512);
        if (tail.some((x) => x !== 0)) fail("tar end marker");
        await cursor.eof();
        break;
      }
      if (++count > c.limits.maxEntries) fail("entry count");
      const sum = octal(h.subarray(148, 156));
      let observed = 0;
      for (let i = 0; i < 512; i++) observed += i >= 148 && i < 156 ? 32 : h[i];
      if (sum !== observed) fail("tar checksum");
      if (
        tarText(h.subarray(257, 263)) !== "ustar" ||
        h.subarray(263, 265).toString() !== "00" ||
        h.subarray(157, 257).some((x) => x !== 0)
      )
        fail("tar format/link");
      const type = h[156];
      if (type !== 48 && type !== 0 && type !== 53) fail("tar special member");
      const directory = type === 53;
      const size = octal(h.subarray(124, 136));
      const prefix = tarText(h.subarray(345, 500));
      const name = (prefix ? prefix + "/" : "") + tarText(h.subarray(0, 100));
      const m = c.add(name, size, directory);
      const chunks = async function* () {
        for (let left = size; left; ) {
          const n = Math.min(CHUNK, left);
          yield await cursor.take(n);
          left -= n;
        }
      };
      if (m && sink) await sink(m, chunks());
      else await discard(chunks());
      const padding = await cursor.take((512 - (size % 512)) % 512);
      if (padding.some((x) => x !== 0)) fail("tar padding");
    }
    if (gzip.bytesWritten !== s.identity.size) fail("gzip trailing input");
    if (consumed.digest("hex") !== s.digest)
      fail("tar consumed bytes hash mismatch");
  } finally {
    input.destroy();
    gzip.destroy();
  }
}
async function walk(s: State, l: Limits, sink?: Sink): Promise<Counter> {
  const c = new Counter(l, s.identity.size);
  if (l.format === "zip") await zipWalk(s, c, sink);
  else await tarWalk(s, c, sink);
  c.finish();
  return c;
}
export async function inspectArchive(
  handle: VerifiedArchiveHandle,
  limits: ArchiveLimits,
): Promise<VerifiedArchivePlan> {
  const s = state(handle);
  if (s.busy) fail("handle in use");
  s.busy = true;
  try {
    await unchanged(s);
    const l = budget(limits),
      c = await walk(s, l);
    await unchanged(s);
    const plan = Object.freeze({
      members: Object.freeze(c.members),
      unpackedSize: c.total,
    });
    plans.set(plan, {
      handle,
      limits: l,
      fingerprint: JSON.stringify(c.members),
    });
    return plan;
  } finally {
    s.busy = false;
  }
}
/** Destination must not exist. It becomes this invocation's controlled, empty staging root. */
export async function extractVerifiedArchive(
  handle: VerifiedArchiveHandle,
  plan: VerifiedArchivePlan,
  destination: string,
): Promise<void> {
  const p = plans.get(plan);
  if (!p || p.handle !== handle) fail("unbound plan");
  const s = state(handle);
  if (s.busy) fail("handle in use");
  s.busy = true;
  const target = path.resolve(destination);
  let owned = false;
  try {
    await unchanged(s);
    const parent = await lstat(path.dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("stage parent");
    await mkdir(target, { mode: 0o700 });
    owned = true;
    const stage = await mkdtemp(path.join(target, ".extract-"));
    const sink: Sink = async (member, chunks) => {
      const output = path.join(stage, member.path);
      if (!output.startsWith(stage + path.sep)) fail("output containment");
      if (member.directory) {
        await mkdir(output, { recursive: true, mode: 0o700 });
        await discard(chunks);
        return;
      }
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      const f = await openBoundFile(output, true);
      try {
        let count = 0;
        for await (const b of chunks) {
          count += b.length;
          if (count > member.size || count > p.limits.maxFileBytes)
            fail("write budget");
          await f.write(b);
        }
        if (count !== member.size) fail("write size");
      } finally {
        await f.close();
      }
    };
    const actual = await walk(s, p.limits, sink);
    if (JSON.stringify(actual.members) !== p.fingerprint) fail("plan changed");
    await unchanged(s);
    for (const name of await readdir(stage))
      await rename(path.join(stage, name), path.join(target, name));
    await rmdir(stage);
  } catch (e) {
    if (owned) await rm(target, { recursive: true, force: true });
    throw e;
  } finally {
    s.busy = false;
  }
}
