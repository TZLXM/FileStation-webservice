import path from "node:path";
import type { BootstrapPathPlan } from "./path-plan";
import { defaultVerifySpace } from "./bootstrap-command";
import { createTempRoot } from "../test-support";

function pathPlan(root: string): BootstrapPathPlan {
  const database = path.join(root, "legacy", "data", "filestation.db");
  const paths = {
    database,
    storage: path.join(root, "legacy", "data", "storage"),
    temp: path.join(root, "legacy", "data", "temp"),
  };
  return {
    legacyRoot: path.join(root, "legacy"),
    installRoot: path.join(root, "managed"),
    previous: paths,
    proposed: paths,
    changes: [],
    relativePathPolicy: "preserve",
  };
}

function artifactBytes(
  plans: Awaited<ReturnType<typeof defaultVerifySpace>>["plans"],
): number {
  return plans
    .flatMap((plan) => plan.components)
    .filter(
      (component) =>
        component.name === "artifact-archive" ||
        component.name === "artifact-unpacked",
    )
    .reduce((total, component) => total + component.bytes, 0);
}

describe("bootstrap disk budget", () => {
  it("reserves four source-tree copies for release, backup, updater and node_modules", async () => {
    const temp = await createTempRoot();
    try {
      const result = await defaultVerifySpace({
        paths: pathPlan(temp.path),
        sourceBytes: 1_000_000,
        databaseBytes: 0,
        backupId: "budget-fixture",
      });

      expect(artifactBytes(result.plans)).toBe(4_000_000);
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed when the four-copy upper bound is not a safe integer", async () => {
    const temp = await createTempRoot();
    try {
      await expect(
        defaultVerifySpace({
          paths: pathPlan(temp.path),
          sourceBytes: Math.floor(Number.MAX_SAFE_INTEGER / 4) + 1,
          databaseBytes: 0,
          backupId: "overflow-fixture",
        }),
      ).rejects.toThrow(/safe integer/i);
    } finally {
      await temp.cleanup();
    }
  });

  it("reserves both protected environment copies as well as source copies", async () => {
    const temp = await createTempRoot();
    try {
      const result = await defaultVerifySpace({
        paths: pathPlan(temp.path), sourceBytes: 1_000_000, databaseBytes: 0,
        backupId: "env-budget", environmentBytes: 80_000_000,
      });
      expect(artifactBytes(result.plans)).toBe(84_000_000);
    } finally { await temp.cleanup(); }
  });

  it("includes manifest overhead even when source files have no content", async () => {
    const temp = await createTempRoot();
    try {
      const result = await defaultVerifySpace({
        paths: pathPlan(temp.path), sourceBytes: 1_000_000, databaseBytes: 0,
        backupId: "manifest-budget", manifestBytes: 100_000_000,
      });
      expect(artifactBytes(result.plans)).toBe(104_000_000);
    } finally { await temp.cleanup(); }
  });
});
