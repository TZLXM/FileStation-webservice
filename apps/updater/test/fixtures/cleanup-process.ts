import { ProcessIdentityProvider } from '../../src/state/boot-identity';

export interface DetachedIdentity { pid: number; createdAt: string; boot: string }

export async function stopDetachedChild(
  child: DetachedIdentity,
  identity: ProcessIdentityProvider,
  signal: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): Promise<void> {
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid < 1 || typeof child.createdAt !== 'string' || !child.createdAt || typeof child.boot !== 'string' || !child.boot) return;
    if ((await identity.current()).value !== child.boot) return;
    // Re-probe creation identity/liveness immediately before signaling. Unknown,
    // exited and reused identities are never grounds to signal a bare PID.
    if (!(await identity.isProcessAlive(child.pid, child.createdAt))) return;
    signal(child.pid, 'SIGKILL');
  } catch {
    // Cleanup must fail closed when identity cannot be proven.
  }
}
