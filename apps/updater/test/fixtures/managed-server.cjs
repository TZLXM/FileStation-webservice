"use strict";

// Controlled release fixture for cross-process updater integration tests.
// SQLite, journal, process identity, fencing, links and launcher are real.
// The HTTP business response is intentionally synthetic and is not deployment
// acceptance evidence.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const sqlite3 = require(__SQLITE3_PATH__);
const {
  decodeInheritedCapability,
  readInheritedEnvelope,
} = require(__CAPABILITY_PATH__);
const { AttemptJournal } = require(__ATTEMPT_JOURNAL_PATH__);

const releaseRoot = path.resolve(__dirname, "../../..");
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(releaseRoot, "package.json"), "utf8"),
).version;

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function marker(root, name) {
  return path.join(root, `fixture-${name}`);
}

function writeStageDiagnostic(error) {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error);
  fs.writeFileSync(
    path.join(process.cwd(), "fixture-stage-error.txt"),
    `${detail}\n`,
  );
  process.stderr.write(`managed-server fixture: ${detail}\n`);
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) =>
      error ? reject(error) : resolve(database),
    );
  });
}

function run(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, (error) => (error ? reject(error) : resolve()));
  });
}

function all(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) =>
      error ? reject(error) : resolve(rows),
    );
  });
}

function close(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

async function migrate(database) {
  await run(
    database,
    "CREATE TABLE IF NOT EXISTS update_schema (version TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  await run(
    database,
    "INSERT INTO update_schema(version, applied_at) VALUES (?, ?)",
    [packageVersion, new Date().toISOString()],
  );
}

function schemaHash(database) {
  return all(
    database,
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).then((schema) =>
    crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
  );
}

async function startHttpServer({ database, port, root, role, authority, attemptId, fence }) {
  let promoteDropped = false;
  const server = http.createServer(async (request, response) => {
    try {
      const token = request.headers["x-filestation-update-capability"];
      const send = (status, body) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };

      if (
        request.method === "GET" &&
        request.url === "/fixture/identity"
      ) {
        return send(200, {
          status: "ok",
          version: packageVersion,
          release: releaseRoot,
          pid: process.pid,
        });
      }

      if (
        request.method === "GET" &&
        request.url === "/api/v1/internal/update/health"
      ) {
        const verified =
          typeof token === "string" &&
          authority.verify(token, {
            attemptId,
            fence,
            purpose: "health",
            method: "GET",
            stage: role,
          });
        if (!verified) return send(401, { error: "capability" });
        if (
          role === "validate" &&
          fs.existsSync(marker(root, "health-failure"))
        ) {
          return send(503, { status: "failed" });
        }
        const snapshot = await AttemptJournal.inspect(root);
        const status =
          role === "validate"
            ? "validating"
            : snapshot.phase === "COMMITTED"
              ? "committed"
              : "gated";
        return send(200, {
          status,
          attempt_id: attemptId,
          fence,
          version: packageVersion,
        });
      }

      if (
        request.method === "POST" &&
        request.url === "/api/v1/internal/update/promote-ready"
      ) {
        const verified =
          typeof token === "string" &&
          authority.verify(token, {
            attemptId,
            fence,
            purpose: "promote",
            method: "POST",
            stage: "gated",
          });
        if (!verified || role !== "gated") {
          return send(401, { error: "capability" });
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.schema_version !== 1) return send(409, { error: "schema" });
        const readiness = {
          attempt_id: attemptId,
          fence,
          target_version: packageVersion,
          migration_id: "fixture-sqlite-migration",
          schema_sha256: await schemaHash(database),
          health: "ok",
        };
        if (
          !promoteDropped &&
          fs.existsSync(marker(root, "promote-drop-once"))
        ) {
          promoteDropped = true;
          response.socket.destroy();
          return;
        }
        return send(201, {
          schema_version: 1,
          readiness,
          receipt: authority.receipt(readiness),
        });
      }

      send(404, { error: "not-found" });
    } catch {
      response.statusCode = 500;
      response.end("fixture-error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function startStage() {
  const role = argument("startup-mode");
  if (role !== "validate" && role !== "gated") {
    throw new Error("fixture stage startup requires validate or gated mode");
  }
  const installRoot = argument("install-root");
  const attemptId = argument("attempt-id");
  const fence = Number(argument("fence"));
  if (
    !installRoot ||
    !attemptId ||
    !Number.isSafeInteger(fence) ||
    fence < 1
  ) {
    throw new Error("fixture stage identity is incomplete");
  }
  const inherited = await readInheritedEnvelope(process.stdin);
  Object.assign(process.env, inherited.runtime);
  const database = await openDatabase(process.env.FILESTATION_DB_PATH);
  await run(database, "PRAGMA busy_timeout = 5000");
  await run(database, "PRAGMA journal_mode = WAL");
  if (role === "validate") {
    await migrate(database);
    if (fs.existsSync(marker(installRoot, "migration-failure"))) {
      throw new Error("fixture migration failed after writing");
    }
  }
  const rows = await all(
    database,
    "SELECT version FROM update_schema WHERE version = ?",
    [packageVersion],
  );
  if (rows.length !== 1) throw new Error("fixture migration marker missing");
  const port = Number(inherited.runtime.FILESTATION_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("fixture stage port is invalid");
  }
  const server = await startHttpServer({
    database,
    port,
    root: installRoot,
    role,
    authority: inherited.authority,
    attemptId,
    fence,
  });
  const shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await close(database).catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function bootstrap() {
  const installRoot =
    process.env.FILESTATION_INSTALL_ROOT ||
    path.dirname(path.dirname(releaseRoot));
  if (fs.existsSync(marker(installRoot, "rollback-start-failure"))) {
    throw new Error("fixture rollback startup failure");
  }
  const database = await openDatabase(process.env.FILESTATION_DB_PATH);
  await run(database, "PRAGMA busy_timeout = 5000");
  await run(database, "PRAGMA journal_mode = WAL");
  if (packageVersion !== "0.2.5") {
    const rows = await all(
      database,
      "SELECT version FROM update_schema WHERE version = ?",
      [packageVersion],
    );
    if (rows.length !== 1) throw new Error("committed migration is unavailable");
  }
  const port = Number(process.env.FILESTATION_PORT ?? 8080);
  const host = process.env.FILESTATION_HOST ?? "127.0.0.1";
  const server = await startHttpServer({
    database,
    port,
    root: installRoot,
    role: "gated",
    authority: decodeInheritedCapability(
      Buffer.from(JSON.stringify({ schemaVersion: 1, key: crypto.randomBytes(32).toString("base64url") })),
    ),
    attemptId: "normal-launch",
    fence: 1,
  });
  const shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await close(database).catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return {
    app: { getHttpServer: () => server },
    restartHealth: {
      health: "ok",
      version: packageVersion,
      release: releaseRoot,
    },
  };
}

module.exports.bootstrap = bootstrap;

if (require.main === module) {
  startStage().catch((error) => {
    writeStageDiagnostic(error);
    process.exitCode = 1;
  });
}
