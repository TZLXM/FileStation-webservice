import { createRequire } from "node:module";
import { chmod, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ReleaseValidationError } from "./validate-version.mjs";

function fail(message) {
  throw new ReleaseValidationError(message);
}

async function migrationFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  }
  await walk(directory);
  return files.sort();
}

async function loadMigrationClasses(artifactRoot) {
  const directory = path.join(
    artifactRoot,
    "apps/server/dist/database/migrations",
  );
  const files = await migrationFiles(directory);
  if (files.length === 0) fail("artifact contains no compiled TypeORM migrations");
  const migrations = [];
  for (const file of files) {
    const module = await import(pathToFileURL(file).href);
    for (const value of Object.values(module)) {
      if (
        typeof value === "function" &&
        typeof value.prototype?.up === "function" &&
        typeof value.prototype?.down === "function"
      ) {
        migrations.push(value);
      }
    }
  }
  if (migrations.length === 0) {
    fail("compiled migration modules expose no TypeORM migration classes");
  }
  return migrations;
}

export async function createSmokeDatabase({
  artifactRoot,
  databasePath,
}) {
  const resolvedArtifact = path.resolve(artifactRoot);
  const resolvedDatabase = path.resolve(databasePath);
  await mkdir(path.dirname(resolvedDatabase), { recursive: true });

  const artifactRequire = createRequire(
    path.join(resolvedArtifact, "package.json"),
  );
  const { DataSource } = artifactRequire("typeorm");
  const migrations = await loadMigrationClasses(resolvedArtifact);
  const dataSource = new DataSource({
    type: "sqlite",
    database: resolvedDatabase,
    migrations,
    migrationsRun: false,
    synchronize: false,
  });

  await dataSource.initialize();
  try {
    const executed = await dataSource.runMigrations();
    if (executed.length === 0 && migrations.length > 0) {
      const rows = await dataSource.query("SELECT name FROM migrations");
      if (rows.length === 0) fail("smoke database did not apply migrations");
    }
    await dataSource.query(
      "INSERT INTO system_meta (key, value) VALUES ('initialized_at', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    await dataSource.query("DELETE FROM system_meta WHERE key = 'init_token'");
    const initialized = await dataSource.query(
      "SELECT value FROM system_meta WHERE key = 'initialized_at'",
    );
    if (initialized.length !== 1) {
      fail("smoke database initialization marker was not persisted");
    }
    const accounts = await dataSource.query(
      "SELECT COUNT(1) AS count FROM admin_accounts",
    );
    if (Number(accounts[0]?.count) !== 0) {
      fail("smoke database must not contain an administrator account");
    }
  } finally {
    await dataSource.destroy();
  }

  if (process.platform !== "win32") await chmod(resolvedDatabase, 0o600);
  return resolvedDatabase;
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    if (
      arguments_.length !== 4 ||
      arguments_[0] !== "--artifact-root" ||
      arguments_[2] !== "--database"
    ) {
      fail(
        "usage: create-smoke-db.mjs --artifact-root <dir> --database <absolute-path>",
      );
    }
    if (!path.isAbsolute(arguments_[1]) || !path.isAbsolute(arguments_[3])) {
      fail("artifact root and database path must be absolute");
    }
    const database = await createSmokeDatabase({
      artifactRoot: arguments_[1],
      databasePath: arguments_[3],
    });
    console.log(database);
  } catch (error) {
    console.error(
      `Smoke database creation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  await main();
}
