import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sqlite3 = require("sqlite3");
import { createBootstrapSnapshot } from "./bootstrap-snapshot";

function openDatabase(
  filename: string,
  mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, mode, (error) => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

function run(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function all<T>(database: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, (error, rows) => {
      if (error) reject(error);
      else resolve(rows as T[]);
    });
  });
}

function close(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("bootstrap SQLite snapshot", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "filestation-task6-snapshot-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses VACUUM INTO from a read-only source and includes committed WAL data", async () => {
    const databasePath = path.join(root, "source.db");
    const outputPath = path.join(root, "snapshot.db");
    const writer = await openDatabase(databasePath);
    await run(writer, "PRAGMA journal_mode=WAL");
    await run(writer, "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
    await run(writer, "INSERT INTO items(value) VALUES ('committed-in-wal')");

    const result = await createBootstrapSnapshot({
      database: databasePath,
      output: outputPath,
    });

    expect(result).toEqual({
      sourceIntegrity: "ok",
      sourceForeignKeys: 0,
      snapshotIntegrity: "ok",
      snapshotForeignKeys: 0,
    });
    const snapshot = await openDatabase(outputPath, sqlite3.OPEN_READONLY);
    try {
      await expect(
        all<{ value: string }>(snapshot, "SELECT value FROM items"),
      ).resolves.toEqual([{ value: "committed-in-wal" }]);
    } finally {
      await close(snapshot);
      await close(writer);
    }
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });

  it("removes the snapshot when foreign-key verification fails", async () => {
    const databasePath = path.join(root, "orphan.db");
    const outputPath = path.join(root, "snapshot.db");
    const source = await openDatabase(databasePath);
    await run(source, "PRAGMA foreign_keys=OFF");
    await run(source, "CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    await run(
      source,
      "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
    );
    await run(source, "INSERT INTO child(parent_id) VALUES (99)");
    await close(source);

    await expect(
      createBootstrapSnapshot({
        database: databasePath,
        output: outputPath,
      }),
    ).rejects.toThrow(/foreign.key/i);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the snapshot when integrity verification returns corruption", async () => {
    const databasePath = path.join(root, "fixture.db");
    const outputPath = path.join(root, "snapshot.db");
    await writeFile(databasePath, "fixture");
    let opens = 0;
    const adapter = {
      openReadonly: jest.fn(async () => {
        opens++;
        return {
          all: async <T>(sql: string): Promise<T[]> => {
            if (sql.includes("integrity_check")) {
              return [
                {
                  integrity_check:
                    opens === 1 ? "ok" : "database disk image is malformed",
                },
              ] as T[];
            }
            return [] as T[];
          },
          run: async () => undefined,
        };
      }),
      close: jest.fn(async () => undefined),
    };
    await writeFile(outputPath, "partial");

    await expect(
      createBootstrapSnapshot({
        database: databasePath,
        output: outputPath,
        sqlite: adapter,
      }),
    ).rejects.toThrow(/output already exists/i);

    await rm(outputPath);
    await expect(
      createBootstrapSnapshot({
        database: databasePath,
        output: outputPath,
        sqlite: adapter,
      }),
    ).rejects.toThrow(/integrity_check failed/i);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens only the source and temporary output with explicit SQLite operations", async () => {
    const calls: Array<{ operation: string; value: string; flags?: number }> = [];
    let current = "";
    const adapter = {
      openReadonly: jest.fn(async (filename: string) => {
        calls.push({ operation: "open-readonly", value: filename });
        current = filename;
        return {
          all: async <T>(sql: string): Promise<T[]> => {
            calls.push({ operation: "all", value: `${current}:${sql}` });
            if (sql.includes("integrity_check")) {
              return [{ integrity_check: "ok" }] as T[];
            }
            if (sql.includes("page_count")) return [{ page_count: 1 }] as T[];
            if (sql.includes("page_size")) return [{ page_size: 4096 }] as T[];
            return [];
          },
          run: async (sql: string) => {
            calls.push({ operation: "run", value: `${current}:${sql}` });
          },
        };
      }),
      close: jest.fn(async () => undefined),
    };
    const databasePath = path.join(root, "fixture.db");
    const outputPath = path.join(root, "snapshot.db");
    await writeFile(databasePath, "fixture");

    await createBootstrapSnapshot({
      database: databasePath,
      output: outputPath,
      sqlite: adapter,
    });

    expect(adapter.openReadonly).toHaveBeenNthCalledWith(1, databasePath);
    expect(adapter.openReadonly).toHaveBeenNthCalledWith(2, outputPath);
    expect(calls.some((call) => call.value.endsWith("VACUUM INTO ?"))).toBe(
      true,
    );
    expect(
      calls.some((call) => call.value.includes("PRAGMA integrity_check")),
    ).toBe(true);
    expect(
      calls.some((call) => call.value.includes("PRAGMA foreign_key_check")),
    ).toBe(true);
  });
});
