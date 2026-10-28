import {
  AttemptJournalSnapshot,
  AttemptPhase,
} from "../state/attempt-journal";
import {
  recoveryActionFor,
  UpdateOrchestrationAttempt,
  UpdateOrchestrator,
  UpdateOrchestratorHooks,
} from "./orchestrator";

function snapshot(phase: AttemptPhase): AttemptJournalSnapshot {
  return {
    initialized: true,
    attemptId: "attempt-orchestrator-01",
    fence: 6,
    phase,
    owner: {
      bootIdentity: "win32:fixture",
      pid: 1234,
      processCreatedAt: "win32:created",
      heartbeatAt: new Date().toISOString(),
    },
    currentVersion: "0.2.0",
    targetVersion: "0.2.5",
    previousVersion: "0.2.0",
    backupId: "backup-orchestrator-01",
    updatedAt: new Date().toISOString(),
    sequence: 1,
    pending: null,
    records: [],
  };
}

const attempt: UpdateOrchestrationAttempt = {
  attemptId: "attempt-orchestrator-01",
  installRoot: "C:\\fixture\\install",
  handoffIdentity: "fixture-handoff",
};

function hooks(
  current: AttemptJournalSnapshot,
): UpdateOrchestratorHooks {
  return {
    inspect: jest
      .fn()
      .mockResolvedValueOnce(snapshot("HANDOFF_READY"))
      .mockResolvedValue(current),
    waitForHandoff: jest.fn(async () => snapshot("HANDOFF_READY")),
    forward: jest.fn(async () => {
      throw new Error("forward failed");
    }),
    rollback: jest.fn(async () => ({
      state: "rolled_back" as const,
      attemptId: attempt.attemptId,
      fence: current.fence,
      reason: "forward failed",
    })),
    restartCommitted: jest.fn(async () => ({
      state: "committed" as const,
      attemptId: attempt.attemptId,
      fence: current.fence,
      version: "0.2.5",
    })),
  };
}

describe("UpdateOrchestrator recovery policy", () => {
  it.each([
    ["PREPARED", "restart-old"],
    ["MAINTENANCE", "restart-old"],
    ["SNAPSHOT_READY", "restart-old"],
    ["HANDOFF_READY", "continue-handoff"],
    ["OLD_STOPPED", "rollback"],
    ["SWITCH_INTENT", "rollback"],
    ["CURRENT_SWITCHED", "rollback"],
    ["MIGRATING", "rollback"],
    ["MIGRATED_VERIFIED", "rollback"],
    ["READY_TO_COMMIT", "rollback"],
    ["COMMITTED", "restart-new"],
    ["ROLLBACK_INTENT", "rollback"],
  ] as const)("maps %s to %s", (phase, action) => {
    expect(recoveryActionFor(snapshot(phase))).toBe(action);
  });

  it("rolls back a pre-COMMITTED forward failure", async () => {
    const value = hooks(snapshot("READY_TO_COMMIT"));
    await expect(new UpdateOrchestrator(value).run(attempt)).resolves.toMatchObject({
      state: "rolled_back",
    });
    expect(value.rollback).toHaveBeenCalledTimes(1);
    expect(value.restartCommitted).not.toHaveBeenCalled();
  });

  it("never rolls back after COMMITTED and only starts the new release", async () => {
    const value = hooks(snapshot("COMMITTED"));
    await expect(new UpdateOrchestrator(value).run(attempt)).resolves.toMatchObject({
      state: "committed",
    });
    expect(value.rollback).not.toHaveBeenCalled();
    expect(value.restartCommitted).toHaveBeenCalledTimes(1);
  });
});
