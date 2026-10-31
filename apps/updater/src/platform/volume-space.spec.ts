import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  planRequiredSpace,
  windowsVolumeIdentity,
  probeActualVolume,
  recheckRequiredSpace,
  type VolumePathSet,
  type VolumeManifest,
} from "./volume-space";
import { createTempRoot } from "../test-support";

const MiB = 1024 * 1024;

function pathsFor(volumeFor: (role: string) => string): VolumePathSet {
  return {
    installRoot: `/v${volumeFor("install")}/install`,
    artifactStaging: `/v${volumeFor("staging")}/staging`,
    releases: `/v${volumeFor("release")}/releases`,
    retainedRelease: `/v${volumeFor("release")}/releases/0.2.0`,
    database: `/v${volumeFor("db")}/data/filestation.db`,
    wal: `/v${volumeFor("db")}/data/filestation.db-wal`,
    shm: `/v${volumeFor("db")}/data/filestation.db-shm`,
    temp: `/v${volumeFor("temp")}/data/temp`,
    backups: `/v${volumeFor("backups")}/backups`,
    snapshot: `/v${volumeFor("backups")}/backups/pre-update.db`,
    restoreTemp: `/v${volumeFor("restore")}/data/filestation.restore.db`,
  };
}

const manifest = {
  database_migration: true,
  migration_workspace_multiplier: 2,
  migration_workspace_min_bytes: 256 * MiB,
  artifacts: [
    {
      archive_size: 1_000,
      unpacked_size: 3_000,
    },
  ],
};

const metrics = {
  pageCount: 10,
  pageSize: 10,
  dbFileBytes: 120,
  walBytes: 10,
  shmBytes: 20,
  snapshotBytes: 130,
};

describe("volume planning", () => {
  it("aggregates every concurrent budget by actual volume on a shared volume", async () => {
    const paths = pathsFor(() => "same");
    const plan = await planRequiredSpace(paths, manifest, metrics, {
      resolveVolumeId: async () => "volume-same",
      readAvailableBytes: async () => 1_000 * MiB,
      minimumSafetyMarginBytes: 64 * MiB,
      retainedReleaseBytes: 2_000,
    });
    expect(plan).toHaveLength(1);
    const total = plan[0];
    expect(total.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "artifact-archive", bytes: 1_000 }),
        expect.objectContaining({ name: "artifact-unpacked", bytes: 3_000 }),
        expect.objectContaining({ name: "retained-release", bytes: 2_000 }),
        expect.objectContaining({ name: "database", bytes: 120 }),
        expect.objectContaining({ name: "database-wal", bytes: 10 }),
        expect.objectContaining({ name: "database-shm", bytes: 20 }),
        expect.objectContaining({ name: "snapshot", bytes: 130 }),
        expect.objectContaining({ name: "restore-temp", bytes: 130 }),
        expect.objectContaining({
          name: "migration-workspace",
          bytes: 256 * MiB,
        }),
      ]),
    );
    const subtotal =
      1_000 + 3_000 + 2_000 + 120 + 10 + 20 + 130 + 130 + 256 * MiB;
    expect(total.safetyMarginBytes).toBe(
      Math.max(64 * MiB, Math.ceil(subtotal * 0.1)),
    );
    expect(total.requiredBytes).toBe(subtotal + total.safetyMarginBytes);
    expect(total.sufficient).toBe(true);
  });

  it("groups separate volumes independently when paths resolve to different volume IDs", async () => {
    const paths = pathsFor((role) => role);
    const roles = [
      "install",
      "staging",
      "release",
      "db",
      "temp",
      "backups",
      "restore",
    ];
    const plan = await planRequiredSpace(paths, manifest, metrics, {
      resolveVolumeId: async (candidate) =>
        `v${
          roles.find((role) =>
            candidate.toLowerCase().includes(`v${role}`),
          ) ?? "unknown"
        }`,
      readAvailableBytes: async () => 512 * MiB,
      minimumSafetyMarginBytes: 64 * MiB,
      retainedReleaseBytes: 2_000,
    });
    expect(plan.map((entry) => entry.volumeId).sort()).toEqual([
      "vbackups",
      "vdb",
      "vinstall",
      "vrelease",
      "vrestore",
      "vstaging",
      "vtemp",
    ]);
    for (const entry of plan) {
      expect(entry.requiredBytes).toBeGreaterThan(0);
      expect(entry.sufficient).toBe(true);
    }
  });

  it("budgets only the artifact for the selected target platform", async () => {
    const paths = pathsFor(() => "same");
    const platformManifest: VolumeManifest = {
      ...manifest,
      artifacts: [
        {
          platform: "windows-x64",
          archive_size: 1_000,
          unpacked_size: 3_000,
        },
        {
          platform: "linux-x64",
          archive_size: 7_000,
          unpacked_size: 11_000,
        },
      ],
    };
    const plan = await planRequiredSpace(
      paths,
      platformManifest,
      metrics,
      {
        artifactPlatform: "windows-x64",
        resolveVolumeId: async () => "volume-same",
        readAvailableBytes: async () => 1_000 * MiB,
        minimumSafetyMarginBytes: 64 * MiB,
        retainedReleaseBytes: 2_000,
      },
    );
    expect(plan[0].components).toContainEqual(
      expect.objectContaining({ name: "artifact-archive", bytes: 1_000 }),
    );
    expect(plan[0].components).toContainEqual(
      expect.objectContaining({ name: "artifact-unpacked", bytes: 3_000 }),
    );
  });

  it("rechecks current WAL and available bytes before maintenance", async () => {
    const paths = pathsFor((role) => role);
    let available = 600 * MiB;
    const roles = [
      "install",
      "staging",
      "release",
      "db",
      "temp",
      "backups",
      "restore",
    ];
    const options = {
      resolveVolumeId: async (candidate: string) =>
        `v${
          roles.find((role) =>
            candidate.toLowerCase().includes(`v${role}`),
          ) ?? "unknown"
        }`,
      readAvailableBytes: async (volumeId: string) =>
        volumeId === "vdb" ? available : 600 * MiB,
      minimumSafetyMarginBytes: 64 * MiB,
      retainedReleaseBytes: 2_000,
    };
    const initial = await planRequiredSpace(paths, manifest, metrics, options);
    expect(initial.find((entry) => entry.volumeId === "vdb")?.sufficient).toBe(
      true,
    );

    available = 100 * MiB;
    const recheck = await recheckRequiredSpace(
      paths,
      manifest,
      {
        ...metrics,
        walBytes: 32 * MiB,
      },
      initial,
      options,
    );
    const db = recheck.plan.find((entry) => entry.volumeId === "vdb");
    expect(db).toMatchObject({
      sufficient: false,
      availableBytes: 100 * MiB,
    });
    expect(db?.components).toContainEqual(
      expect.objectContaining({
        name: "database-wal",
        bytes: 32 * MiB,
      }),
    );
    expect(recheck.changed).toBe(true);
  });

  it("never deletes the previous release or unique recoverable snapshot", async () => {
    const temp = await createTempRoot();
    try {
      const previous = path.join(temp.path, "releases", "0.2.0", "marker");
      const snapshot = path.join(temp.path, "backups", "pre-update.db");
      await mkdir(path.dirname(previous), { recursive: true });
      await mkdir(path.dirname(snapshot), { recursive: true });
      await writeFile(previous, "previous");
      await writeFile(snapshot, "snapshot");
      const paths: VolumePathSet = {
        installRoot: temp.path,
        artifactStaging: path.join(temp.path, "staging"),
        releases: path.join(temp.path, "releases"),
        retainedRelease: path.dirname(previous),
        database: path.join(temp.path, "data", "filestation.db"),
        wal: path.join(temp.path, "data", "filestation.db-wal"),
        shm: path.join(temp.path, "data", "filestation.db-shm"),
        temp: path.join(temp.path, "data", "temp"),
        backups: path.join(temp.path, "backups"),
        snapshot,
        restoreTemp: path.join(temp.path, "data", "restore.db"),
      };
      const plan = await planRequiredSpace(paths, manifest, metrics, {
        readAvailableBytes: async () => 0,
        minimumSafetyMarginBytes: 64 * MiB,
        retainedReleaseBytes: 2_000,
      });
      expect(plan.every((entry) => !entry.sufficient)).toBe(true);
      expect(await import("node:fs/promises").then((fs) => fs.readFile(previous, "utf8"))).toBe(
        "previous",
      );
      expect(await import("node:fs/promises").then((fs) => fs.readFile(snapshot, "utf8"))).toBe(
        "snapshot",
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("resolves a real filesystem volume ID and available-byte count", async () => {
    const temp = await createTempRoot();
    try {
      const result = await probeActualVolume(temp.path);
      expect(result.volumeId.length).toBeGreaterThan(0);
      expect(result.availableBytes).toBeGreaterThan(0);
      expect(Number.isSafeInteger(result.availableBytes)).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("review volume regressions", () => {
  it("combines mount aliases by volume GUID and separates distinct GUIDs", async () => {
    const api = { volumeSerial: () => 12345, volumePath: (candidate: string) => (candidate.includes("vdb") || candidate.startsWith("D:")) ? "D:\\alias\\" : "C:\\", volumeGuid: (_mount: string) => "\\\\?\\Volume{same}\\" };
    expect(windowsVolumeIdentity("C:\\", api)).toBe(windowsVolumeIdentity("D:\\alias\\", api));
    const plan = await planRequiredSpace(pathsFor(role => role === "db" ? "db" : "other"),
      { database_migration: false, migration_workspace_multiplier: 0, migration_workspace_min_bytes: 0, artifacts: [{ archive_size: 100, unpacked_size: 100 }] },
      { pageCount: 0, pageSize: 4096, dbFileBytes: 100, walBytes: 0, shmBytes: 0, snapshotBytes: 0 }, {
      resolveVolumeId: async candidate => windowsVolumeIdentity(candidate, api), readAvailableBytes: async () => 250,
      retainedReleaseBytes: 0, minimumSafetyMarginBytes: 0,
    });
    expect(plan).toHaveLength(1); expect(plan[0].sufficient).toBe(false);
    expect(windowsVolumeIdentity("C:\\", { ...api, volumeGuid: () => "volume-other" })).not.toBe(plan[0].volumeId);
  });
  it.each(["db", "logical", "snapshot"])("uses the large %s migration base without minimum masking", async winner => {
    const large = 512 * MiB;
    const fixture = { ...metrics, dbFileBytes: winner === "db" ? large : 100, snapshotBytes: winner === "snapshot" ? large : 100, pageCount: winner === "logical" ? large / 4096 : 1, pageSize: 4096 };
    const [plan] = await planRequiredSpace(pathsFor(() => "same"), manifest, fixture, { resolveVolumeId: async () => "same", readAvailableBytes: async () => 10 * 1024 * MiB });
    expect(plan.components.find(c => c.name === "migration-workspace")?.bytes).toBe(large * 2);
    const sum = plan.components.reduce((n, c) => n + c.bytes, 0);
    expect(plan.requiredBytes).toBe(sum + Math.ceil(sum * .1));
  });
});
