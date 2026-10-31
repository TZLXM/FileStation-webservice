import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Portable equivalent of the source npm start scripts; no dev dependency.
export function startupEnvironment(environment, byNginx = false) {
  return {
    ...environment,
    FILESTATION_SERVE_STATIC: byNginx ? "false" : "true",
    FILESTATION_HOST: byNginx ? "127.0.0.1" : "0.0.0.0",
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(argument => argument !== "--bynginx")) throw new Error("usage: start-artifact.mjs [--bynginx]");
  Object.assign(process.env, startupEnvironment(process.env, process.argv.includes("--bynginx")));
  // Import in this process so service stop/termination also stops the server.
  const server = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/dist/main.js")).href);
  if (typeof server.bootstrap !== "function") {
    throw new Error("artifact server entrypoint does not export bootstrap()");
  }
  // Dynamic import does not make main.js the CommonJS entry module, so the
  // shipped launcher must invoke the exported bootstrap explicitly.
  await server.bootstrap();
}
