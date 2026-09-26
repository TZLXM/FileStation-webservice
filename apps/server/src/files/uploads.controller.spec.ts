import { UploadsController } from './uploads.controller';

describe('UploadsController audit events', () => {
  const uploadsService = {
    initializeUpload: jest.fn(),
    completeUpload: jest.fn(),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let controller: UploadsController;
  const req = {
    user: { id: 'admin-1' },
    ip: '198.51.100.28',
    headers: { 'user-agent': 'Audit test agent' },
    once: jest.fn(),
    removeListener: jest.fn(),
  } as any;
  const res = {
    writableEnded: false,
    once: jest.fn(),
    removeListener: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UploadsController(uploadsService as any, auditService as any);
  });

  it('returns the upload token and audits only the initiated upload id', async () => {
    uploadsService.initializeUpload.mockResolvedValue({
      upload_id: 'upload-1',
      upload_token: 'upload-secret',
      chunk_size: 1024,
      expires_at: '2026-09-25T00:00:00.000Z',
    });

    const result = await controller.initialize({ filename: 'report.pdf', size: 4096 } as any, req);

    expect(result).toMatchObject({ code: 'OK', data: { upload_id: 'upload-1', upload_token: 'upload-secret' } });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'upload.initiated',
      resourceType: 'upload',
      resourceId: 'upload-1',
      ip: '198.51.100.28',
      userAgent: 'Audit test agent',
    });
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain('upload-secret');
  });

  it('keeps the completion response shape and audits filename and size', async () => {
    uploadsService.completeUpload.mockResolvedValue({ file_id: 'file-1', filename: 'report.pdf', size: 4096 });

    const result = await controller.complete('upload-1', 'upload-secret', {} as any, req, res);

    expect(result).toMatchObject({ code: 'OK', data: { file_id: 'file-1' } });
    expect(result?.data).toEqual({ file_id: 'file-1' });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: null,
      action: 'upload.completed',
      resourceType: 'upload',
      resourceId: 'upload-1',
      details: { filename: 'report.pdf', size: 4096 },
      ip: '198.51.100.28',
      userAgent: 'Audit test agent',
    });
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain('upload-secret');
    expect(uploadsService.completeUpload.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
  });
});
