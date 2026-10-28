import { RecoveryService } from './recovery.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';

describe('RecoveryService maintenance gate', () => {
  const codes = {};
  const accounts = {};
  const totp = {};
  const audit = {};
  const sqlite = { run: jest.fn() };

  let barrier: WriteBarrierService;
  let service: RecoveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    const freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new RecoveryService(
      codes as any,
      accounts as any,
      totp as any,
      audit as any,
      sqlite as any,
      barrier,
      freeze,
    );
  });

  it('does not begin recovery cleanup after maintenance closes', async () => {
    barrier.enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(service.cleanupExpiredIpReservations()).resolves.toBeUndefined();

    expect(sqlite.run).not.toHaveBeenCalled();
    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('runs cleanup under a counted background lease while admitted', async () => {
    sqlite.run.mockResolvedValue(undefined);

    await service.cleanupExpiredIpReservations();

    expect(sqlite.run).toHaveBeenCalledTimes(1);
    expect(barrier.activeLeaseCount).toBe(0);
  });
});
