import path from "node:path";
import {
  ManagedInstallMetadata,
  validateManagedLaunch,
} from "./managed-preflight";

describe("managed server preflight", () => {
  const installRoot = path.resolve("/fixture/managed");
  const currentPath = path.join(installRoot, "current");
  const currentRelease = path.join(installRoot, "releases/v0.2.0");
  const metadata: ManagedInstallMetadata = {
    schemaVersion: 1,
    installId: "fixture-install-id",
    installRoot,
    currentPath,
    environmentPath: path.join(installRoot, ".env"),
    paths: {
      database: path.resolve("/fixture/data/files.db"),
      storage: path.resolve("/fixture/data/storage"),
      temp: path.resolve("/fixture/data/temp"),
    },
    bootstrapBackupId: "fixture-backup-id",
    bootstrapFingerprint: "b".repeat(64),
    createdAt: "2026-10-28T00:00:00.000Z",
  };

  it("returns the validated canonical launch plan", () => {
    const plan = validateManagedLaunch({
      cwd: installRoot,
      executableRealpath: path.join(
        currentRelease,
        "apps/server/dist/main.js",
      ),
      currentRealpath: currentRelease,
      installMetadata: metadata,
      configuredPaths: metadata.paths,
    });

    expect(plan).toEqual(
      expect.objectContaining({
        installId: "fixture-install-id",
        installRoot,
        releaseRealpath: currentRelease,
        paths: metadata.paths,
      }),
    );
  });

  it("rejects a configured path that resolves to a different target", () => {
    expect(() =>
      validateManagedLaunch({
        cwd: installRoot,
        executableRealpath: path.join(
          currentRelease,
          "apps/server/dist/main.js",
        ),
        currentRealpath: currentRelease,
        installMetadata: metadata,
        configuredPaths: {
          database: path.resolve("/fixture/different/files.db"),
        },
      }),
    ).toThrow(/database.*canonical path/i);
  });
});
