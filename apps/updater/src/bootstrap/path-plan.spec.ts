import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planBootstrapPaths } from "./path-plan";

describe("bootstrap path plan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "filestation-task6-path-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires an explicit resolution for relative legacy paths", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");

    await expect(
      planBootstrapPaths({
        legacyRoot,
        installRoot,
        configuredPaths: {
          database: "./state/files.db",
          storage: "./state/storage",
          temp: "./state/temp",
        },
      }),
    ).rejects.toThrow(/relative.*preserve.*managed/i);
  });

  it("uses documented defaults when an environment omits path variables", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");

    const plan = await planBootstrapPaths({
      legacyRoot,
      installRoot,
      configuredPaths: {
        database: undefined,
        storage: undefined,
        temp: undefined,
      },
      relativePathPolicy: "preserve",
    });

    expect(plan.proposed).toEqual({
      database: path.join(legacyRoot, "data/filestation.db"),
      storage: path.join(legacyRoot, "data/storage"),
      temp: path.join(legacyRoot, "data/temp"),
    });
  });

  it("preserves relative legacy targets under the canonical source root", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");

    const plan = await planBootstrapPaths({
      legacyRoot,
      installRoot,
      configuredPaths: {
        database: "./state/files.db",
        storage: "./state/storage",
        temp: "./state/temp",
      },
      relativePathPolicy: "preserve",
    });

    expect(plan.proposed).toEqual({
      database: path.join(legacyRoot, "state/files.db"),
      storage: path.join(legacyRoot, "state/storage"),
      temp: path.join(legacyRoot, "state/temp"),
    });
    expect(plan.changes.every((change) => change.changed === false)).toBe(true);
  });

  it("moves relative legacy targets only under an explicit managed resolution", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");

    const plan = await planBootstrapPaths({
      legacyRoot,
      installRoot,
      configuredPaths: {
        database: "./state/files.db",
        storage: "./state/storage",
        temp: "./state/temp",
      },
      relativePathPolicy: "managed",
    });

    expect(plan.proposed).toEqual({
      database: path.join(installRoot, "state/files.db"),
      storage: path.join(installRoot, "state/storage"),
      temp: path.join(installRoot, "state/temp"),
    });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "database",
          changed: true,
          requestedPolicy: "managed",
        }),
      ]),
    );
  });

  it("preserves absolute paths and rejects a different custom target without acknowledgement", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");
    const database = path.join(root, "elsewhere/database.sqlite");
    const storage = path.join(root, "elsewhere/storage");
    const temp = path.join(root, "elsewhere/temp");
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "fixture");

    const plan = await planBootstrapPaths({
      legacyRoot,
      installRoot,
      configuredPaths: { database, storage, temp },
      relativePathPolicy: "preserve",
    });
    expect(plan.proposed.database).toBe(database);

    await expect(
      planBootstrapPaths({
        legacyRoot,
        installRoot,
        configuredPaths: { database, storage, temp },
        overrides: {
          database: path.join(root, "different/database.sqlite"),
        },
        relativePathPolicy: "preserve",
      }),
    ).rejects.toThrow(/accept.*path.*change/i);
  });

  it("resolves a missing target through its nearest existing canonical ancestor", async () => {
    const legacyRoot = path.join(root, "legacy");
    const installRoot = path.join(root, "managed");
    await mkdir(path.join(root, "real-parent"), { recursive: true });

    const plan = await planBootstrapPaths({
      legacyRoot,
      installRoot,
      configuredPaths: {
        database: "../real-parent/new/database.sqlite",
        storage: "../real-parent/new/storage",
        temp: "../real-parent/new/temp",
      },
      relativePathPolicy: "preserve",
    });

    expect(plan.proposed.database).toBe(
      path.join(root, "real-parent/new/database.sqlite"),
    );
  });
});
