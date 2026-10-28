"use strict";

const path = require("node:path");
const sqlite3 = require(__SQLITE3_PATH__);
const { acquireRecoveryGuard } = require(__RECOVERY_GUARD_PATH__);

const root = process.argv[2];
const databasePath = process.argv[3];
if (!root || !databasePath) throw new Error("old writer paths are required");

function open() {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, (error) =>
      error ? reject(error) : resolve(database),
    );
  });
}

function run(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, (error) => (error ? reject(error) : resolve()));
  });
}

function close(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const guard = await acquireRecoveryGuard(
    path.join(root, "update.recovery.guard"),
  );
  const database = await open();
  await run(database, "PRAGMA journal_mode = WAL");
  await run(database, "PRAGMA wal_autocheckpoint = 0");
  await run(
    database,
    "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  process.send?.({ event: "ready", pid: process.pid });
  process.on("message", async (message) => {
    try {
      if (message === "write") {
        await run(
          database,
          "INSERT INTO items(value) VALUES (?)",
          ["wal-before-update"],
        );
        process.send?.({ event: "written" });
      } else if (message === "drain") {
        process.send?.({ event: "drained" });
      } else if (message === "close") {
        await close(database);
        await guard.release();
        process.disconnect?.();
      }
    } catch (error) {
      process.send?.({ event: "error", error: error.message });
    }
  });
}

main().catch((error) => {
  process.stderr.write(`old-writer fixture: ${error.message}\n`);
  process.exitCode = 1;
});
