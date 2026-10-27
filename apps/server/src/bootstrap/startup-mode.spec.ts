import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectStartupMode } from "./startup-mode";

describe("server startup mode", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "filestation-task6-startup-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retains legacy mode when no managed metadata exists", async () => {
    const cwd = path.join(root, "source");
    const executable = path.join(cwd, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");

    await expect(
      detectStartupMode({
        cwd,
        executableRealpath: executable,
      }),
    ).resolves.toEqual({ mode: "legacy", root: cwd });
  });

  it("finds a managed root from a current-release executable", async () => {
    const installRoot = path.join(root, "managed");
    const release = path.join(installRoot, "releases/v0.2.0");
    const executable = path.join(release, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(
      path.join(installRoot, "managed-install.json"),
      "{}\n",
    );

    await expect(
      detectStartupMode({
        cwd: installRoot,
        executableRealpath: executable,
      }),
    ).resolves.toEqual({ mode: "managed", root: installRoot });
  });

  it("fails closed when an explicit managed launch has no metadata", async () => {
    const installRoot = path.join(root, "managed");
    const executable = path.join(
      installRoot,
      "releases/v0.2.0/apps/server/dist/main.js",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");

    await expect(
      detectStartupMode({
        cwd: installRoot,
        executableRealpath: executable,
        environment: {
          FILESTATION_MANAGED_LAUNCH: "true",
          FILESTATION_INSTALL_ROOT: installRoot,
        },
      }),
    ).rejects.toThrow(/managed-install\.json.*missing/i);
  });
});
