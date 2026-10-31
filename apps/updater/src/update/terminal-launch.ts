import path from 'node:path';
import { AttemptJournal, JsonValue } from '../state/attempt-journal';
import { PlatformBootIdentityProvider } from '../state/boot-identity';
import { UpdateCapabilityAuthority } from './capability';

type Grant = { root:string; release:string; attemptId:string; fence:number; version:string; phase:string; expiresAt:number };
const key = Symbol.for('filestation.internal.terminalLaunch');
// Standalone launcher and release dependency may be separate copies. The
// verified process-local grant crosses that boundary without argv/env/storage.
const state = globalThis as typeof globalThis & { [key]?: Grant };

/** Called only by the stable launcher after reading its inherited anonymous pipe. */
export async function acceptTerminalLaunch(root:string, launch:Record<string, JsonValue>, authority:UpdateCapabilityAuthority):Promise<void> {
  const {receipt,...claims}=launch;
  if(typeof receipt!=='string' || !authority.verifyReceipt(receipt,claims as never)) throw new Error('terminal launch signature invalid');
  const snapshot=await AttemptJournal.inspect(root);
  if(snapshot.attemptId!==claims.attemptId || snapshot.fence!==claims.fence || snapshot.phase!==claims.phase || !snapshot.owner ||
    !['COMMITTED','ROLLED_BACK','ABORTED'].includes(snapshot.phase!) || typeof claims.release!=='string' || typeof claims.version!=='string' || typeof claims.expiresAt!=='number' || Date.now()>claims.expiresAt ||
    snapshot.owner.pid!==claims.parentPid || snapshot.owner.processCreatedAt!==claims.parentCreatedAt || snapshot.owner.bootIdentity!==claims.parentBoot ||
    !['verify-committed-restart','launch-terminal'].includes(snapshot.pending?.action ?? '')) throw new Error('terminal launch journal authority mismatched');
  const identity=new PlatformBootIdentityProvider();
  if((await identity.current()).value!==claims.parentBoot || !(await identity.isProcessAlive(snapshot.owner.pid,snapshot.owner.processCreatedAt))) throw new Error('terminal launcher parent is absent');
  state[key]={root:path.resolve(root),release:path.resolve(claims.release),attemptId:snapshot.attemptId!,fence:snapshot.fence,version:claims.version,phase:snapshot.phase!,expiresAt:claims.expiresAt};
}

export async function terminalLaunchAllowed(root:string, release:string):Promise<boolean> {
  const grant=state[key];
  if(!grant || grant.root!==path.resolve(root) || grant.release!==path.resolve(release) || Date.now()>grant.expiresAt) return false;
  const snapshot=await AttemptJournal.inspect(root);
  if(snapshot.attemptId!==grant.attemptId || snapshot.fence!==grant.fence || snapshot.phase!==grant.phase) throw new Error('terminal launch authority changed');
  return true;
}
