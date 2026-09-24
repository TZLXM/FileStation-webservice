import { AuditController } from './audit.controller';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

describe('AuditController', () => {
  const auditService = { findAll: jest.fn() };
  let controller: AuditController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuditController(auditService as any);
  });

  it('returns the shared pagination result and forwards filters', async () => {
    const page = { items: [], total: 0, page: 2, page_size: 20, total_pages: 1 };
    auditService.findAll.mockResolvedValue(page);

    const result = await controller.list({ page: 2, page_size: 20, action: 'auth.login' });

    expect(result).toMatchObject({ code: 'OK', message: 'Success', data: page });
    expect(result.request_id).toEqual(expect.any(String));
    expect(auditService.findAll).toHaveBeenCalledWith(2, 20, 'auth.login');
  });

  it('defaults to the first page and 20 entries', async () => {
    auditService.findAll.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20, total_pages: 1 });

    await controller.list(new ListAuditLogsDto());

    expect(auditService.findAll).toHaveBeenCalledWith(1, 20, undefined);
  });
});
