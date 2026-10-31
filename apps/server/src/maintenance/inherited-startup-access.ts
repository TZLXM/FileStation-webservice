import { AttemptJournal, UpdateCapabilityAuthority, readInheritedEnvelope } from '@filestation/updater';
import {
  TrustedStartupAccess,
  UpdateProtocolCredentials,
  UpdateStartupIntent,
} from './startup-authority';

const MAX_HEARTBEAT_AGE_MS = 10 * 60 * 1000;

function allowedStartupPhase(
  intent: UpdateStartupIntent,
  phase: string | undefined,
  pendingAction: string | undefined,
): boolean {
  if (intent.mode === 'validate') {
    return (
      phase === 'CURRENT_SWITCHED' ||
      (phase === 'MIGRATING' && pendingAction === 'validate-release')
    );
  }
  return phase === 'MIGRATED_VERIFIED' || phase === 'READY_TO_COMMIT';
}

export class InheritedTrustedStartupAccess
  implements TrustedStartupAccess
{
  constructor(
    private readonly authority: UpdateCapabilityAuthority,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static async fromInherited(
    source: AsyncIterable<Uint8Array>,
    now: () => number = () => Date.now(),
  ): Promise<InheritedTrustedStartupAccess> {
    const {authority,runtime}=await readInheritedEnvelope(source);
    Object.assign(process.env,runtime);
    return new InheritedTrustedStartupAccess(
      authority,
      now,
    );
  }

  async authorizeStartup(intent: UpdateStartupIntent): Promise<void> {
    let snapshot;
    try {
      snapshot = await AttemptJournal.inspect(intent.attempt.installRoot);
    } catch {
      throw new Error('update startup authority cannot read a verified journal');
    }
    if (
      snapshot.attemptId !== intent.attempt.attemptId ||
      snapshot.fence !== intent.attempt.fence ||
      snapshot.backupId !== intent.attempt.backupId ||
      snapshot.targetVersion !== intent.attempt.targetVersion ||
      !snapshot.owner
    ) {
      throw new Error('update startup attempt or fence is mismatched');
    }
    if (
      !allowedStartupPhase(
        intent,
        snapshot.phase,
        snapshot.pending?.action,
      )
    ) {
      throw new Error(
        `update ${intent.mode} pre-import phase is not authorized`,
      );
    }
    const heartbeat = Date.parse(snapshot.owner.heartbeatAt);
    const age = this.now() - heartbeat;
    if (
      !Number.isFinite(heartbeat) ||
      age < -60_000 ||
      age > MAX_HEARTBEAT_AGE_MS
    ) {
      throw new Error('update startup owner heartbeat is stale');
    }
  }

  async authorizeRequest(
    intent: UpdateStartupIntent,
    credentials: UpdateProtocolCredentials,
  ): Promise<void> {
    if (
      !credentials.capability ||
      credentials.attemptId !== intent.attempt.attemptId ||
      credentials.fence !== intent.attempt.fence
    ) {
      throw new Error('update capability is missing or mismatched');
    }
    const verified = this.authority.verify(credentials.capability, {
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      purpose: credentials.purpose,
      method: credentials.method,
      stage: credentials.stage,
      now: this.now(),
    });
    if (!verified) throw new Error('update capability is invalid');
  }

  signReceipt(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('update readiness payload is invalid');
    }
    return this.authority.receipt(
      payload as Record<
        string,
        string | number | boolean | null | unknown[]
      > as never,
    );
  }
}
