import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, deflateRawSync } from "node:zlib";
import {
  openVerifiedArchive,
  inspectArchive,
  extractVerifiedArchive,
} from "./archive-policy";
export const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
type Entry = {
  name: string;
  data?: Buffer;
  type?: number;
  size?: number;
};
const root = "filestation-v0.2.5-";
const files = [
  "apps/server/dist/main.js",
  "apps/updater/dist/cli.js",
  "apps/updater/dist/launcher.js",
  "apps/web/dist-root/index.html",
  "apps/web/dist-fs/index.html",
  "packages/shared/dist/index.js",
  "packages/update-core/dist/index.js",
  "packages/update-core/package.json",
  "apps/updater/package.json",
  "scripts/bootstrap-update.ps1",
  "scripts/bootstrap-update.sh",
  "scripts/start-filestation.ps1",
  "scripts/start-filestation.sh",
  "node_modules/lib/index.js",
];
export const zip = (entries: Entry[]) => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const n = Buffer.from(e.name);
    const b = e.data ?? Buffer.from("ok");
    const c = deflateRawSync(b);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(b), 14);
    h.writeUInt32LE(c.length, 18);
    h.writeUInt32LE(e.size ?? b.length, 22);
    h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46);
    d.writeUInt32LE(0x02014b50);
    d.writeUInt16LE(0x0314, 4);
    h.copy(d, 6, 4, 26);
    d.writeUInt16LE(n.length, 28);
    d.writeUInt32LE(((e.type ?? 0o100644) * 65536) >>> 0, 38);
    d.writeUInt32LE(offset, 42);
    local.push(h, n, c);
    central.push(d, n);
    offset += h.length + n.length + c.length;
  }
  const c = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, c, end]);
};
export const tar = (entries: Entry[]) => {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const b = e.data ?? Buffer.from("ok");
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write("0000644\0", 100);
    h.write((e.size ?? b.length).toString(8).padStart(11, "0") + "\0", 124);
    h.fill(32, 148, 156);
    h[156] = e.type ?? 48;
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const c of h) sum += c;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, b, Buffer.alloc((512 - (b.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
};
const safe = (format: string): Entry[] =>
  files.map((name) => ({
    name: root + (format === "zip" ? "win-x64/" : "linux-x64/") + name,
  }));
const limits = (format = "zip") => ({
  format: format as "zip" | "tar.gz",
  version: "0.2.5",
  platform: format === "zip" ? "windows-x64" : "linux-x64",
  unpackedSize: files.length * 2,
  maxEntries: 32,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxRatio: 200,
  maxArchiveBytes: 100000,
});
describe("actual archive bytes, handle binding and controlled extraction", () => {
  test("cleans only its created destination when an actual output create fails", async () => {
    const b = zip([
      ...safe("zip"),
      { name: root + "win-x64/" + "x".repeat(300) },
    ]);
    const h = await open(b);
    try {
      const p = await inspectArchive(h, {
        ...limits(),
        unpackedSize: (files.length + 1) * 2,
      });
      await mkdir(path.join(dir, "unrelated"));
      await writeFile(path.join(dir, "unrelated", "keep"), "keep");
      await expect(
        extractVerifiedArchive(h, p, path.join(dir, "out")),
      ).rejects.toThrow();
      await expect(readFile(path.join(dir, "out", files[0]))).rejects.toThrow();
      expect(await readFile(path.join(dir, "unrelated", "keep"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await h.close();
    }
  });
  test.each(["zip", "tar.gz"])(
    "rejects missing runtime layout and multiple roots %s",
    async (f) => {
      for (const entries of [
        safe(f).slice(1),
        safe(f).filter((entry) => !entry.name.endsWith("/apps/web/dist-root/index.html")),
        safe(f).filter((entry) => !entry.name.endsWith("/apps/web/dist-fs/index.html")),
        [...safe(f), { name: "filestation-v9.9.9-linux-x64/a" }],
      ]) {
        const h = await open(f === "zip" ? zip(entries) : tar(entries));
        try {
          await expect(
            inspectArchive(h, {
              ...limits(f),
              unpackedSize: entries.length * 2,
            }),
          ).rejects.toThrow();
        } finally {
          await h.close();
        }
      }
    },
  );
  test("rejects corrupted gzip, trailing compressed input and tar size mismatch", async () => {
    const normal = tar(safe("tar.gz"));
    for (const b of [
      normal.subarray(0, normal.length - 5),
      Buffer.concat([normal, Buffer.from("junk")]),
      tar([{ ...safe("tar.gz")[0], size: 1000 }, ...safe("tar.gz").slice(1)]),
    ]) {
      const h = await open(b);
      try {
        await expect(inspectArchive(h, limits("tar.gz"))).rejects.toThrow();
      } finally {
        await h.close();
      }
    }
  });
  test("rejects ZIP encryption and central/local metadata mismatch", async () => {
    for (const mutate of [
      (b: Buffer) => b.writeUInt16LE(1, 6),
      (b: Buffer) => b.writeUInt32LE(999, 22),
      (b: Buffer) => b.writeUInt16LE(1, b.length - 22 + 4),
    ]) {
      const b = zip(safe("zip"));
      mutate(b);
      const h = await open(b);
      try {
        await expect(inspectArchive(h, limits())).rejects.toThrow();
      } finally {
        await h.close();
      }
    }
  });
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fs-archive-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const open = async (b: Buffer) => {
    const p = path.join(dir, "source");
    await writeFile(p, b);
    return openVerifiedArchive(p, createHash("sha256").update(b).digest("hex"));
  };
  test.each(["zip", "tar.gz"])(
    "extracts realistic publisher %s with bound handle",
    async (format) => {
      const h = await open(
        format === "zip" ? zip(safe(format)) : tar(safe(format)),
      );
      try {
        const plan = await inspectArchive(h, limits(format));
        await extractVerifiedArchive(h, plan, path.join(dir, "out"));
        expect(await readFile(path.join(dir, "out", files[0]), "utf8")).toBe(
          "ok",
        );
      } finally {
        await h.close();
      }
    },
  );
  test.each([
    "../evil",
    "/absolute",
    "C:/evil",
    "//server/share",
    "a/../../escape",
    "a\\evil",
    "data/file",
    ".env",
    ".env.local",
    "updater/a",
    "apps/../evil",
    "CON",
    "a:stream",
    "a.",
  ])("rejects malicious path %s in ZIP and tar", async (name) => {
    for (const format of ["zip", "tar.gz"]) {
      const entries = [
        ...safe(format),
        { name: root + (format === "zip" ? "win-x64/" : "linux-x64/") + name },
      ];
      if (name.startsWith("/") || name.startsWith("C:")) entries[4].name = name;
      const h = await open(format === "zip" ? zip(entries) : tar(entries));
      try {
        await expect(
          inspectArchive(h, { ...limits(format), unpackedSize: 10 }),
        ).rejects.toThrow();
      } finally {
        await h.close();
      }
    }
  });
  test.each([49, 50, 51, 52, 54, 55])(
    "rejects tar special type %s",
    async (type) => {
      const h = await open(
        tar([...safe("tar.gz"), { name: root + "linux-x64/link", type }]),
      );
      try {
        await expect(
          inspectArchive(h, { ...limits("tar.gz"), unpackedSize: 10 }),
        ).rejects.toThrow();
      } finally {
        await h.close();
      }
    },
  );
  test.each([0o120777, 0o020666, 0o060666, 0o010666, 0o140666])(
    "rejects ZIP special mode %s",
    async (type) => {
      const h = await open(
        zip([...safe("zip"), { name: root + "win-x64/link", type }]),
      );
      try {
        await expect(
          inspectArchive(h, { ...limits(), unpackedSize: 10 }),
        ).rejects.toThrow();
      } finally {
        await h.close();
      }
    },
  );
  test.each(["apps/server/dist/main.js", "APPS/server/dist/MAIN.js"])(
    "rejects duplicate or case collision %s",
    async (name) => {
      for (const f of ["zip", "tar.gz"]) {
        const h = await open(
          f === "zip"
            ? zip([...safe(f), { name: root + "win-x64/" + name }])
            : tar([...safe(f), { name: root + "linux-x64/" + name }]),
        );
        try {
          await expect(
            inspectArchive(h, { ...limits(f), unpackedSize: 10 }),
          ).rejects.toThrow();
        } finally {
          await h.close();
        }
      }
    },
  );
  test.each([
    { maxEntries: 3 },
    { maxFileBytes: 1 },
    { maxTotalBytes: 7 },
    { unpackedSize: 9 },
    { maxRatio: 0.01 },
    { maxArchiveBytes: 1 },
  ])("enforces resource limit %j", async (change) => {
    for (const f of ["zip", "tar.gz"]) {
      const h = await open(f === "zip" ? zip(safe(f)) : tar(safe(f)));
      try {
        await expect(
          inspectArchive(h, { ...limits(f), ...change }),
        ).rejects.toThrow();
      } finally {
        await h.close();
      }
    }
  });
  test("rejects ZIP declared size bomb and CRC corruption", async () => {
    for (const b of [
      zip([{ ...safe("zip")[0], size: 999999 }]),
      (() => {
        const b = zip(safe("zip"));
        b[14] ^= 1;
        return b;
      })(),
    ]) {
      const h = await open(b);
      try {
        await expect(inspectArchive(h, limits())).rejects.toThrow();
      } finally {
        await h.close();
      }
    }
  });
  test("source pathname replacement is blocked or retains original inspected input", async () => {
    const b = zip(safe("zip"));
    const h = await open(b);
    try {
      const p = await inspectArchive(h, limits());
      let blocked = false;
      try {
        await rename(path.join(dir, "source"), path.join(dir, "old"));
        await writeFile(path.join(dir, "source"), Buffer.from("evil"));
      } catch (e) {
        if (process.platform !== "win32") throw e;
        blocked = true;
      }
      await extractVerifiedArchive(h, p, path.join(dir, "out"));
      expect(await readFile(path.join(dir, "out", files[0]), "utf8")).toBe(
        "ok",
      );
      if (process.platform === "win32") expect(blocked).toBe(true);
    } finally {
      await h.close();
    }
  });
  test("rejects hash mismatch, forged plan, and existing destination without cleanup", async () => {
    await writeFile(path.join(dir, "bad"), "bad");
    await expect(
      openVerifiedArchive(path.join(dir, "bad"), "0".repeat(64)),
    ).rejects.toThrow();
    const h = await open(zip(safe("zip")));
    try {
      const p = await inspectArchive(h, limits());
      await mkdir(path.join(dir, "out"));
      await writeFile(path.join(dir, "out", "keep"), "keep");
      await expect(
        extractVerifiedArchive(h, p, path.join(dir, "out")),
      ).rejects.toThrow();
      expect(await readFile(path.join(dir, "out", "keep"), "utf8")).toBe(
        "keep",
      );
      await expect(
        extractVerifiedArchive(h, { ...p }, path.join(dir, "forged")),
      ).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
  test("rejects real directory junction source (Windows) or symlink source", async () => {
    const target = path.join(dir, "target");
    await mkdir(target);
    const b = zip(safe("zip"));
    await writeFile(path.join(target, "a"), b);
    const link = path.join(dir, "link");
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      openVerifiedArchive(
        path.join(link, "a"),
        createHash("sha256").update(b).digest("hex"),
      ),
    ).rejects.toThrow();
  });
});

test("rejects duplicate publisher root directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fs-root-"));
  const name = root + "win-x64/";
  const b = zip([
    ...safe("zip"),
    { name, data: Buffer.alloc(0), type: 0o040755 },
    { name, data: Buffer.alloc(0), type: 0o040755 },
  ]);
  const file = path.join(dir, "source");
  await writeFile(file, b);
  const h = await openVerifiedArchive(
    file,
    createHash("sha256").update(b).digest("hex"),
  );
  try {
    await expect(inspectArchive(h, limits())).rejects.toThrow();
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
