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
    inspect: jest.fn().mockResolvedValue(current),
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
  it.each(['PREPARED','MAINTENANCE','SNAPSHOT_READY'] as const)('normal inherited continuation waits through %s without taking recovery ownership',async phase=>{
    const value=hooks(snapshot(phase)); value.inspect=async()=>snapshot(phase);
    value.forward=jest.fn(async()=>({state:'rolled_back' as const,attemptId:attempt.attemptId,fence:6,reason:'fixture finished'}));
    await new UpdateOrchestrator(value).run(attempt);
    expect(value.waitForHandoff).toHaveBeenCalledTimes(1);
    expect(value.forward).toHaveBeenCalled();
    expect(value.rollback).not.toHaveBeenCalled();
  });
  it.each(['PREPARED','MAINTENANCE','SNAPSHOT_READY','OLD_STOPPED','CURRENT_SWITCHED','MIGRATING','READY_TO_COMMIT','ROLLBACK_INTENT'] as const)('dispatches initial %s into real recovery rather than waiting for handoff',async phase=>{
    const value=hooks(snapshot(phase)); value.inspect=async()=>snapshot(phase);
    await new UpdateOrchestrator(value).run({...attempt,recovery:true});
    expect(value.waitForHandoff).not.toHaveBeenCalled();
    expect(value.rollback).toHaveBeenCalled();
  });
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

describe('identity bound termination',()=>{
 it('does not allow replacement or DB work between SIGKILL and proven exit',async()=>{
   const {stopServer}=await import('./orchestrator');
   const {EventEmitter}=await import('node:events');
   let live=true;
   const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null,kill:jest.fn(()=>true)});
   const server={child,baseUrl:'http://fixture',stage:'validate',stopped:false,processCreatedAt:'fixture-created'};
   const identity={isProcessAlive:async()=>live};
   const stopping=stopServer(server as never,identity as never,10);
   let progressed=false; void stopping.then(()=>{progressed=true;},()=>{});
   await new Promise(r=>setTimeout(r,15));
   expect(child.kill).toHaveBeenCalledWith('SIGKILL');
   expect(server.stopped).toBe(false); expect(progressed).toBe(false);
   live=false; child.emit('exit',null,'SIGKILL');
   await stopping; expect(server.stopped).toBe(true);
 });
 it('fails closed when SIGKILL never establishes exit',async()=>{
   const {stopServer}=await import('./orchestrator');
   const {EventEmitter}=await import('node:events');
   const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null,kill:()=>false});
   const server={child,stage:'validate',stopped:false,processCreatedAt:'fixture'};
   await expect(stopServer(server as never,{isProcessAlive:async()=>true} as never,5)).rejects.toThrow(/exit|stop/i);
   expect(server.stopped).toBe(false);
 });
});
