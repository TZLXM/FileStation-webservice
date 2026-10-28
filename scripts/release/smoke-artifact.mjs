import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createSmokeDatabase } from "./create-smoke-db.mjs";
import { ReleaseValidationError } from "./validate-version.mjs";

function fail(message) {
  throw new ReleaseValidationError(message);
}

export function redactSmokeOutput(value) {
  return String(value)
    .replace(
      /(?:初始化\s*Token|INIT(?:_TOKEN)?|JWT_SECRET|PASSWORD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)\s*[:=]\s*[^\s]+/giu,
      (match) => `${match.split(/[:=]/u, 1)[0].trim()}=REDACTED`,
    )
    .replace(/Authorization:\s*Bearer\s+[^\s]+/giu, "Authorization: Bearer REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer REDACTED")
    .slice(0, 1024);
}

function redactSmokeOutputPreservingPrefix(value) {
  const redacted = redactSmokeOutput(value);
  return redacted.replace(/^.{0,200}?([A-Z]+=REDACTED)/u, "$1");
}

function safeChildEnvironment({ port, databasePath, storagePath, tempPath }) {
  const inherited = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|JWT)/iu.test(key)
    ) {
      continue;
    }
    if (key.toUpperCase() === "FILESTATION_SERVE_STATIC" || key.toUpperCase() === "FILESTATION_HOST") continue;
    inherited[key] = value;
  }
  return {
    ...inherited,
    NODE_ENV: "production",
    JWT_SECRET: randomBytes(32).toString("hex"),
    FILESTATION_PORT: String(port),
    FILESTATION_DB_PATH: databasePath,
    FILESTATION_STORAGE_PATH: storagePath,
    FILESTATION_TEMP_PATH: tempPath,
  };
}

const WEB_BUNDLES = [
  { name: "root", directory: "dist-root", base: "/" },
  { name: "fs", directory: "dist-fs", base: "/fs/" },
];

function extractAssetPath(html, base) {
  const assetPath = /(?:src|href)=["']([^"']+\.(?:js|css))["']/u.exec(html)?.[1];
  if (!assetPath || !assetPath.startsWith(`${base}assets/`)) {
    fail(`Web bundle does not reference a ${base}assets/ JS or CSS asset`);
  }
  return assetPath;
}

async function inspectWebBundle(artifactRoot, bundle) {
  const root = path.join(artifactRoot, "apps/web", bundle.directory);
  const html = await readFile(path.join(root, "index.html"), "utf8");
  if (!html.includes("data-asset-recovery")) {
    fail(`${bundle.directory}/index.html is missing the early recovery bootstrap`);
  }
  return {
    root,
    html,
    assetPath: extractAssetPath(html, bundle.base),
  };
}

function assertIndexCache(headers) {
  if (headers.get("cache-control") !== "no-store") {
    fail("Web index was not served with Cache-Control: no-store");
  }
}

function assertImmutableAsset(headers) {
  if (!headers.get("cache-control")?.includes("immutable")) {
    fail("hashed Web asset was not served as immutable");
  }
}

async function startPrefixStaticServer({ artifactRoot, apiOrigin }) {
  const bundle = await inspectWebBundle(
    artifactRoot,
    WEB_BUNDLES.find((entry) => entry.name === "fs"),
  );
  const assetRoot = path.join(bundle.root, "assets");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/fs") {
        response.writeHead(301, { Location: "/fs/" });
        response.end();
        return;
      }
      if (url.pathname.startsWith("/fs/api/")) {
        const upstream = await fetch(
          `${apiOrigin}${url.pathname.slice("/fs".length)}${url.search}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        const body = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname.startsWith("/fs/assets/")) {
        const filename = decodeURIComponent(url.pathname.slice("/fs/assets/".length));
        if (!filename || filename.includes("/") || filename.includes("\\")) {
          response.writeHead(404);
          response.end();
          return;
        }
        const file = path.join(assetRoot, filename);
        const fileInfo = await stat(file);
        if (!fileInfo.isFile()) {
          response.writeHead(404);
          response.end();
          return;
        }
        const body = await readFile(file);
        response.writeHead(200, {
          "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript",
          "Content-Length": String(body.length),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        response.end(body);
        return;
      }
      if (url.pathname.startsWith("/fs/")) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(bundle.html);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : "static smoke failure");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || !address) {
    await new Promise((resolve) => server.close(resolve));
    fail("failed to bind the /fs/ artifact smoke server");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function nativeDependencyCheck(artifactRoot) {
  const artifactRequire = createRequire(
    path.join(artifactRoot, "package.json"),
  );
  const sqlite3 = artifactRequire("sqlite3");
  const bcrypt = artifactRequire("bcrypt");
  await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(":memory:", (error) => {
      if (error) {
        reject(error);
        return;
      }
      database.get("SELECT 1 AS value", (queryError, row) => {
        database.close();
        if (queryError) reject(queryError);
        else if (Number(row?.value) !== 1) reject(new Error("sqlite3 query failed"));
        else resolve();
      });
    });
  });
  const hash = await bcrypt.hash("smoke-only", 4);
  if (!(await bcrypt.compare("smoke-only", hash))) {
    fail("bcrypt native round-trip failed");
  }
  return {
    sqlite3: JSON.parse(
      await readFile(
        artifactRequire.resolve("sqlite3/package.json"),
        "utf8",
      ),
    ).version,
    bcrypt: JSON.parse(
      await readFile(
        artifactRequire.resolve("bcrypt/package.json"),
        "utf8",
      ),
    ).version,
  };
}

async function choosePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("failed to reserve a smoke-test port"));
        else resolve(port);
      });
    });
  });
}

function captureChild(child, limit = 128 * 1024) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > limit) output = output.slice(-limit);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output;
}

async function waitForHealth(port, child, getOutput, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(
        `artifact server exited before health check (status ${child.exitCode})`,
      );
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/settings/public`,
        { signal: AbortSignal.timeout(2_000) },
      );
      const body = await response.json();
      if (response.ok && body.code === "OK" && body.data?.name) return;
    } catch {
      // The server may still be applying migrations.
    }
    if (/初始化\s*Token|init_token/iu.test(getOutput())) {
      fail("smoke server unexpectedly entered initialization-token mode");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("artifact server did not pass the public-settings health check in time");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export async function smokeArtifact({
  artifactRoot,
  temporaryRoot = null,
  keepTemporary = false,
}) {
  const resolvedArtifact = path.resolve(artifactRoot);
  if (!path.isAbsolute(artifactRoot)) {
    fail("artifactRoot must be an absolute path");
  }
  const version = JSON.parse(
    await readFile(path.join(resolvedArtifact, "package.json"), "utf8"),
  ).version;
  if (typeof version !== "string" || version.length === 0) {
    fail("artifact package.json has no product version");
  }

  let resolvedTemporary;
  let ownsTemporary = false;
  if (temporaryRoot) {
    if (!path.isAbsolute(temporaryRoot)) {
      fail("temporaryRoot must be an absolute path");
    }
    resolvedTemporary = path.resolve(temporaryRoot);
    await mkdir(resolvedTemporary, { recursive: true });
  } else {
    resolvedTemporary = await mkdtemp(
      path.join(tmpdir(), "filestation-artifact-smoke-"),
    );
    ownsTemporary = true;
  }

  let child = null;
  let prefixServer = null;
  let getOutput = () => "";
  try {
    const rootBundle = await inspectWebBundle(
      resolvedArtifact,
      WEB_BUNDLES.find((entry) => entry.name === "root"),
    );
    const fsBundle = await inspectWebBundle(
      resolvedArtifact,
      WEB_BUNDLES.find((entry) => entry.name === "fs"),
    );
    if (rootBundle.assetPath === fsBundle.assetPath) {
      fail("root and /fs/ Web bundles reference the same entry asset");
    }
    const nativeVersions = await nativeDependencyCheck(resolvedArtifact);
    const databasePath = path.join(resolvedTemporary, "data/filestation.db");
    const storagePath = path.join(resolvedTemporary, "data/storage");
    const tempPath = path.join(resolvedTemporary, "data/temp");
    await mkdir(storagePath, { recursive: true });
    await mkdir(tempPath, { recursive: true });
    await createSmokeDatabase({
      artifactRoot: resolvedArtifact,
      databasePath,
    });

    const port = await choosePort();
    child = spawn(process.execPath, ["scripts/release/start-artifact.mjs"], {
      cwd: resolvedArtifact,
      env: safeChildEnvironment({
        port,
        databasePath,
        storagePath,
        tempPath,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    getOutput = captureChild(child);
    await waitForHealth(port, child, getOutput);
    const base = "http://127.0.0.1:" + port;
    const page = await fetch(base + "/");
    const html = await page.text();
    if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) fail("shipped startup did not serve index HTML");
    assertIndexCache(page.headers);
    if (!html.includes("data-asset-recovery")) fail("root index HTML is missing the early recovery bootstrap");
    const asset = await fetch(base + rootBundle.assetPath);
    if (!asset.ok || !/javascript|css/u.test(asset.headers.get("content-type") ?? "") || (await asset.arrayBuffer()).byteLength === 0) fail("referenced static asset failed");
    assertImmutableAsset(asset.headers);
    prefixServer = await startPrefixStaticServer({
      artifactRoot: resolvedArtifact,
      apiOrigin: base,
    });
    const fsIndex = await fetch(`${prefixServer.origin}/fs/`);
    const fsIndexHtml = await fsIndex.text();
    if (!fsIndex.ok || fsIndexHtml !== fsBundle.html) fail("/fs/ index did not come from dist-fs");
    assertIndexCache(fsIndex.headers);
    const fsRouter = await fetch(`${prefixServer.origin}/fs/files`);
    if (!fsRouter.ok || await fsRouter.text() !== fsBundle.html) fail("/fs/ SPA router fallback did not serve dist-fs");
    assertIndexCache(fsRouter.headers);
    const fsAsset = await fetch(`${prefixServer.origin}${fsBundle.assetPath}`);
    if (
      !fsAsset.ok ||
      !/javascript|css/u.test(fsAsset.headers.get("content-type") ?? "") ||
      (await fsAsset.arrayBuffer()).byteLength === 0
    ) fail("/fs/ referenced static asset failed");
    assertImmutableAsset(fsAsset.headers);
    const fsApi = await fetch(
      `${prefixServer.origin}/fs/api/v1/settings/public`,
    );
    const fsApiBody = await fsApi.json();
    if (
      !fsApi.ok ||
      fsApiBody.code !== "OK" ||
      typeof fsApiBody.data?.name !== "string"
    ) fail("/fs/api/v1/ did not reach the canonical API");
    const output = getOutput();
    if (
      /(?:JWT_SECRET|PASSWORD|TOKEN|SECRET|PRIVATE_KEY)\s*[:=]\s*[^\s]+/iu.test(
        output,
      )
    ) {
      fail("artifact server wrote a credential-like value to logs");
    }
    return {
      version,
      nativeVersions,
      publicSettings: "ok",
      staticIndex: "ok",
      referencedAsset: "ok",
      webBundles: {
        root: {
          index: "ok",
          asset: "ok",
          bootstrap: "ok",
          cache: "ok",
        },
        fs: {
          index: "ok",
          asset: "ok",
          api: "ok",
          router: "ok",
          bootstrap: "ok",
          cache: "ok",
        },
      },
      startupEntrypoint: "scripts/release/start-artifact.mjs",
      databaseInitializedWithoutAccount: true,
    };
  } catch (error) {
    const summary = redactSmokeOutputPreservingPrefix(getOutput());
    if (summary) console.error(summary);
    throw error;
  } finally {
    if (prefixServer) await prefixServer.close();
    if (child) await stopChild(child);
    if (ownsTemporary && !keepTemporary) {
      await rm(resolvedTemporary, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    if (
      arguments_.length !== 2 ||
      arguments_[0] !== "--artifact-root" ||
      !path.isAbsolute(arguments_[1])
    ) {
      fail("usage: smoke-artifact.mjs --artifact-root <absolute-dir>");
    }
    const result = await smokeArtifact({ artifactRoot: arguments_[1] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      `Artifact smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  await main();
}
