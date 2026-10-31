import { WriteBarrierService } from './write-barrier.service';
import { WriteFreezeService } from './write-freeze.service';

describe('WriteBarrierService', () => {
  const attempt = {
    attemptId: 'attempt-01',
    fence: 7,
    installRoot: 'C:\\fixture\\install',
    backupId: 'backup-01',
    targetVersion: '0.2.5',
  };

  let freeze: WriteFreezeService;
  let barrier: WriteBarrierService;

  beforeEach(() => {
    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
  });

  it('rejects all new leases once maintenance starts and drains existing leases', async () => {
    const lease = await barrier.acquire('http');

    barrier.enterMaintenance(attempt);

    await expect(barrier.acquire('cron:file-lifecycle')).rejects.toMatchObject({
      code: 'UPDATE_MAINTENANCE',
    });
    expect(barrier.activeLeaseCount).toBe(1);

    const drained = barrier.waitForZero(Date.now() + 1_000);
    lease.release();
    await expect(drained).resolves.toBeUndefined();
    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('lets nested work reuse an already-counted outer lease after admission closes', async () => {
    await barrier.withLease('http', async () => {
      barrier.enterMaintenance(attempt);

      await expect(
        barrier.withLease('upload-finalizer', async () => 'finished'),
      ).resolves.toBe('finished');
      expect(barrier.activeLeaseCount).toBe(1);
    });

    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('forks a separately counted child for work that may outlive the request', async () => {
    await barrier.withLease('http', async () => {
      const finalizer = await barrier.forkLease('upload-finalizer');
      barrier.enterMaintenance(attempt);

      expect(barrier.activeLeaseCount).toBe(2);
      finalizer.release();
      expect(barrier.activeLeaseCount).toBe(1);
    });

    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('restores admission on abort before the irreversible freeze', async () => {
    barrier.enterMaintenance(attempt);
    await expect(barrier.acquire('http')).rejects.toMatchObject({
      code: 'UPDATE_MAINTENANCE',
    });

    barrier.abortMaintenance(attempt);
    const lease = await barrier.acquire('http');

    expect(lease.source).toBe('http');
    lease.release();
  });

  it('never restores admission after the frozen latch is sealed', async () => {
    barrier.enterMaintenance(attempt);
    freeze.freeze(attempt);

    expect(() => barrier.abortMaintenance(attempt)).toThrow(
      /irreversible|frozen/i,
    );
    await expect(barrier.acquire('http')).rejects.toMatchObject({
      code: 'UPDATE_MAINTENANCE',
    });
  });

  it('rejects an abort for a different attempt or fence', async () => {
    barrier.enterMaintenance(attempt);

    expect(() =>
      barrier.abortMaintenance({ ...attempt, fence: attempt.fence + 1 }),
    ).toThrow(/attempt|fence/i);
  });

  it('runs committed activation under a private lease without opening external admission', async () => {
    barrier.enterMaintenance(attempt);
    const authority = barrier.beginCommittedActivation(attempt);
    let entered!: () => void;
    const activationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activation = barrier.withCommittedActivation(
      authority,
      'startup-scan',
      async () => {
        entered();
        await activationGate;
      },
    );
    await activationEntered;
    await expect(barrier.acquire('http')).rejects.toMatchObject({
      code: 'UPDATE_MAINTENANCE',
    });
    release();
    await expect(activation).resolves.toBeUndefined();
    barrier.finishCommittedActivation(authority);
    expect(() =>
      barrier.reopenAfterCommitted({ ...attempt, fence: attempt.fence + 1 }),
    ).toThrow(/attempt|fence/i);
    barrier.reopenAfterCommitted(attempt);
    expect(barrier.accepting).toBe(true);
  });
});
