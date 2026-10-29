import {
  AttemptJournalSnapshot,
  AttemptPhase,
} from "../state/attempt-journal";
import {
  ManagedUpdateHooks,
  recoveryActionFor,
  UpdateOrchestrationAttempt,
  UpdateOrchestrator,
  UpdateOrchestratorHooks,
} from "./orchestrator";
import path from 'node:path';

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

describe('W20-I01 durable terminal intent release boundary',()=>{
  it.each(['canonical','trailing','relative','different','missing','non-string'] as const)('validates %s intent before probing the recorded child',async mode=>{
    const installRoot=path.resolve('fixture-terminal-boundary');
    const release=path.join(installRoot,'releases/v0.2.0-old');
    const current=snapshot('ROLLED_BACK');
    const payload={version:'0.2.0',release:mode==='canonical'?release:mode==='trailing'?release+path.sep:mode==='relative'?path.relative(installRoot,release):mode==='different'?path.join(installRoot,'releases/v0.2.5-other'):mode==='missing'?undefined:42};
    current.records=[
      {id:'terminal-intent',kind:'intent',action:'launch-terminal',phase:'ROLLED_BACK',payload},
      {kind:'completion',intentId:'terminal-intent',phase:'ROLLED_BACK',context:{attemptId:attempt.attemptId},result:{pid:12345,createdAt:'fixture-created',boot:'fixture-boot',nonce:'fixture-nonce-long-enough',health:'ok',version:'0.2.0',release}},
    ] as unknown as AttemptJournalSnapshot['records'];
    const alive=jest.fn().mockResolvedValue(false);
    const active=jest.fn().mockResolvedValue(undefined);
    const hooks=new ManagedUpdateHooks('',{
      fs:{exists:async()=>false,realpath:async()=>release} as never,
      identity:{current:async()=>({value:'fixture-boot'}),isProcessAlive:alive} as never,
    });
    Object.assign(hooks,{ownership:{journal:{readSnapshot:async()=>current},recovery:{assertActive:active}}});
    // In-memory boundary: no native signaling or filesystem mutation is possible.
    const recover=(hooks as unknown as {stopRecordedChildren(a:UpdateOrchestrationAttempt):Promise<void>}).stopRecordedChildren({...attempt,installRoot});
    if(mode==='canonical' || mode==='trailing') {
      await expect(recover).resolves.toBeUndefined();
      expect(alive).toHaveBeenCalledWith(12345,'fixture-created');
    } else {
      await expect(recover).rejects.toThrow('durable terminal child identity/version proof mismatched');
      expect(alive).not.toHaveBeenCalled();
    }
    expect(active).toHaveBeenCalledTimes(1);
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
