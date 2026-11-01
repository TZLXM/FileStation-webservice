import { access, rm } from "node:fs/promises";
import path from "node:path";
import sqlite3 = require("sqlite3");

export interface SnapshotConnection {
  all<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  run(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface SnapshotSqliteAdapter {
  openReadonly(filename: string): Promise<SnapshotConnection>;
  close(connection: SnapshotConnection): Promise<void>;
}

export interface BootstrapSnapshotOptions {
  database: string;
  output: string;
  sqlite?: SnapshotSqliteAdapter;
}

export interface BootstrapSnapshotResult {
  sourceIntegrity: "ok";
  sourceForeignKeys: 0;
  snapshotIntegrity: "ok";
  snapshotForeignKeys: 0;
}

class NativeSnapshotConnection implements SnapshotConnection {
  constructor(readonly database: sqlite3.Database) {}

  all<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.database.all<T>(sql, parameters, (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    });
  }

  run(sql: string, parameters: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.run(sql, parameters, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

const nativeSqlite: SnapshotSqliteAdapter = {
  openReadonly(filename) {
    return new Promise((resolve, reject) => {
      const database = new sqlite3.Database(
        filename,
        sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
        (error) => {
          if (error) reject(error);
          else resolve(new NativeSnapshotConnection(database));
        },
      );
    });
  },
  close(connection) {
    return new Promise((resolve, reject) => {
      (connection as NativeSnapshotConnection).database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  },
};

async function ensureMissing(filename: string): Promise<void> {
  try {
    await access(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`snapshot output already exists: ${filename}`);
}

async function verify(
  connection: SnapshotConnection,
  label: string,
): Promise<{ integrity: "ok"; foreignKeys: 0 }> {
  const integrityRows = await connection.all<{ integrity_check: string }>(
    "PRAGMA integrity_check",
  );
  if (
    integrityRows.length !== 1 ||
    integrityRows[0]?.integrity_check !== "ok"
  ) {
    throw new Error(`${label} SQLite integrity_check failed`);
  }
  const foreignKeyRows = await connection.all<Record<string, unknown>>(
    "PRAGMA foreign_key_check",
  );
  if (foreignKeyRows.length !== 0) {
    throw new Error(`${label} SQLite foreign_key_check found violations`);
  }
  return { integrity: "ok", foreignKeys: 0 };
}

export async function createBootstrapSnapshot(
  options: BootstrapSnapshotOptions,
): Promise<BootstrapSnapshotResult> {
  if (!path.isAbsolute(options.database) || !path.isAbsolute(options.output)) {
    throw new Error("snapshot database and output paths must be absolute");
  }
  try {
    await access(options.database);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`snapshot source database is missing: ${options.database}`);
    }
    throw error;
  }
  await ensureMissing(options.output);
  const sqlite = options.sqlite ?? nativeSqlite;
  let source: SnapshotConnection | undefined;
  let snapshot: SnapshotConnection | undefined;
  try {
    source = await sqlite.openReadonly(options.database);
    await source.run("PRAGMA busy_timeout = 5000");
    const sourceVerification = await verify(source, "source");
    await source.run("VACUUM INTO ?", [options.output]);
    await sqlite.close(source);
    source = undefined;

    snapshot = await sqlite.openReadonly(options.output);
    await snapshot.run("PRAGMA busy_timeout = 5000");
    const snapshotVerification = await verify(snapshot, "snapshot");
    return {
      sourceIntegrity: sourceVerification.integrity,
      sourceForeignKeys: sourceVerification.foreignKeys,
      snapshotIntegrity: snapshotVerification.integrity,
      snapshotForeignKeys: snapshotVerification.foreignKeys,
    };
  } catch (error) {
    await rm(options.output, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (snapshot) await sqlite.close(snapshot).catch(() => {});
    if (source) await sqlite.close(source).catch(() => {});
  }
}

function parseArguments(argv: string[]): BootstrapSnapshotOptions {
  let database: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(
        "Usage: bootstrap-snapshot.js --db <canonical-db> --out <protected-snapshot>\n",
      );
      process.exitCode = 0;
      return { database: "", output: "" };
    }
    if (argument !== "--db" && argument !== "--out") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--db") database = value;
    else output = value;
  }
  if (!database || !output) {
    throw new Error("--db and --out are required");
  }
  return { database, output };
}

if (require.main === module) {
  createBootstrapSnapshot(parseArguments(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "snapshot failed"}\n`,
      );
      process.exitCode = 1;
    });
}
