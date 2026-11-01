import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
    const release = path.join(installRoot, "releases/v0.2.0-0123456789ab");
    const executable = path.join(release, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(
      path.join(installRoot, "managed-install.json"),
      "{}\n",
    );

    const current = path.join(installRoot, "current");
    await symlink(release, current, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(detectStartupMode({
        cwd: installRoot,
        executableRealpath: await realpath(path.join(current, "apps/server/dist/main.js")),
        environment: {},
      })).resolves.toEqual({ mode: "managed", root: installRoot });
    } finally { await unlink(current); }
  });

  it("fails closed when an explicit managed launch has no metadata", async () => {
    const installRoot = path.join(root, "managed");
    const executable = path.join(
      installRoot,
      "releases/v0.2.0-0123456789ab/apps/server/dist/main.js",
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
  it.each(["release", "updater", "current"])("rejects genuine bootstrap layout without metadata or env: %s", async (entry) => {
    const installRoot = path.join(root, "managed");
    const release = path.join(installRoot, "releases/v0.2.0-0123456789ab");
    const executable = entry === "updater"
      ? path.join(installRoot, "updater/dist/cli.js")
      : path.join(release, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    const current = path.join(installRoot, "current");
    try {
      if (entry === "current") await symlink(release, current, process.platform === "win32" ? "junction" : "dir");
      const resolved = await realpath(entry === "current" ? path.join(current, "apps/server/dist/main.js") : executable);
      await expect(detectStartupMode({ cwd: installRoot, executableRealpath: resolved, environment: {} }))
        .rejects.toThrow(/managed.*missing/i);
    } finally { if (entry === "current") await unlink(current); }
  });

  it.each(["updater", "releases", "current"])("retains legacy mode beside an unrelated ancestor child: %s", async (sibling) => {
    const cwd = path.join(root, "legacy-filestation");
    const executable = path.join(cwd, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await mkdir(path.join(root, sibling));
    await expect(detectStartupMode({ cwd, executableRealpath: executable, environment: {} }))
      .resolves.toEqual({ mode: "legacy", root: cwd });
  });

  it.each(["updater", "releases", "current"])("does not infer managed mode from generic entries in an unrelated cwd: %s", async (sibling) => {
    const deployment = path.join(root, "legacy-filestation");
    const executable = path.join(deployment, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await mkdir(path.join(root, sibling));
    await expect(detectStartupMode({ cwd: root, executableRealpath: executable, environment: {} }))
      .resolves.toEqual({ mode: "legacy", root });
  });

  it.each([".bootstrap-in-progress.json", "update-attempt.journal", "update.lock", "update.recovery.lock"])("rejects a specific residual marker at the actual deployment root: %s", async (marker) => {
    const deployment = path.join(root, "legacy-filestation");
    const executable = path.join(deployment, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(path.join(deployment, marker), "fixture");
    await expect(detectStartupMode({ cwd: root, executableRealpath: executable, environment: {} }))
      .rejects.toThrow(/managed-install\.json.*missing/i);
  });

  it.each(["update.lock", "current"])("rejects a dangling marker at the actual deployment root before import or write: %s", async (markerName) => {
    const deployment = path.join(root, "legacy-filestation");
    const executable = path.join(deployment, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    const marker = path.join(deployment, markerName);
    await symlink(path.join(root, "absent-marker-target"), marker, process.platform === "win32" ? "junction" : "dir");
    const importer = jest.fn(); const writer = jest.fn();
    try {
      await expect((async () => {
        await detectStartupMode({ cwd: deployment, executableRealpath: executable, environment: {} });
        importer(); writer();
      })()).rejects.toThrow(/managed-install\.json.*missing/i);
      expect(importer).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
    } finally { await unlink(marker); }
  });

  it("detects a genuine old managed release even when cwd is outside the installation", async () => {
    const install = path.join(root, "managed");
    const executable = path.join(install, "releases/v0.1.9-abcdef012345/apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await expect(detectStartupMode({ cwd: root, executableRealpath: executable, environment: {} }))
      .rejects.toThrow(/managed-install\.json.*missing/i);
    await writeFile(path.join(install, "managed-install.json"), "{}\n");
    await expect(detectStartupMode({ cwd: root, executableRealpath: executable, environment: {} }))
      .resolves.toEqual({ mode: "managed", root: install });
  });

  it("rejects an environment-only managed request without metadata", async () => {
    const deployment = path.join(root, "legacy-filestation");
    const executable = path.join(deployment, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await expect(detectStartupMode({ cwd: deployment, executableRealpath: executable, environment: { FILESTATION_MANAGED_LAUNCH: "true" } }))
      .rejects.toThrow(/managed.*missing/i);
  });

  it.each(["updater", "releases", "current"])("still rejects a managed-layout entry owned by the actual deployment root: %s", async (entry) => {
    const deployment = path.join(root, "legacy-filestation");
    const executable = path.join(deployment, "apps/server/dist/main.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await mkdir(path.join(deployment, entry));
    await expect(detectStartupMode({ cwd: root, executableRealpath: executable, environment: {} }))
      .rejects.toThrow(/managed-install\.json.*missing/i);
  });

});
