import { FilesController } from './files.controller';

describe('FilesController audit events', () => {
  const filesService = { delete: jest.fn() };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let controller: FilesController;
  const req = {
    user: { id: 'admin-1' },
    ip: '203.0.113.71',
    headers: { 'user-agent': 'Audit test agent' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new FilesController(filesService as any, auditService as any);
  });

  it('keeps the deletion response and audits the deleted file id', async () => {
    filesService.delete.mockResolvedValue(undefined);

    const result = await controller.delete('file-1', req);

    expect(result).toMatchObject({ code: 'OK', message: 'File deletion queued', data: null });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'file.deleted',
      resourceType: 'file',
      resourceId: 'file-1',
      ip: '203.0.113.71',
      userAgent: 'Audit test agent',
    });
  });

  it('does not emit a deletion event when deletion fails', async () => {
    filesService.delete.mockRejectedValue(new Error('delete failed'));

    await expect(controller.delete('file-1', req)).rejects.toThrow('delete failed');
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
