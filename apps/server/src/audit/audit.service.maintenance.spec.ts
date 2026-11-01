import { AuditService } from './audit.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';

describe('AuditService maintenance gate', () => {
  const repository = {
    save: jest.fn(),
    delete: jest.fn(),
  };
  let freeze: WriteFreezeService;
  let barrier: WriteBarrierService;
  let service: AuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new AuditService(repository as any, barrier, freeze);
  });

  it('does not add audit writes after maintenance closes', async () => {
    barrier.enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await service.record({
      accountId: null,
      action: 'fixture.blocked',
    });
    await expect(service.purgeExpired()).resolves.toBe(0);

    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('finishes nested audit work under an already-counted request lease', async () => {
    repository.save.mockResolvedValue({});
    await barrier.withLease('http', async () => {
      barrier.enterMaintenance({
        attemptId: 'attempt-01',
        fence: 1,
        installRoot: 'C:\\fixture',
        backupId: 'backup-01',
        targetVersion: '0.2.5',
      });
      await service.record({
        accountId: null,
        action: 'fixture.nested',
      });
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('drains an explicitly leased purge before the barrier reaches zero', async () => {
    repository.delete.mockResolvedValue({ affected: 2 });

    await expect(service.purgeExpired()).resolves.toBe(2);
    expect(repository.delete).toHaveBeenCalledTimes(1);
    expect(barrier.activeLeaseCount).toBe(0);
  });
});
