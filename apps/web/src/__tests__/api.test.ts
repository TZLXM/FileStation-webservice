import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';

describe('upload API request headers and failures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const okResponse = { ok: true, status: 200, json: vi.fn(async () => ({ code: 'OK', data: {}, request_id: 'r1' })) };

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(okResponse as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    api.setAccessToken('admin-jwt');
  });

  afterEach(() => {
    api.setAccessToken(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('passes caller headers to GET while preserving the admin Authorization header', async () => {
    await api.get('/uploads/upload-1', { 'X-Upload-Token': 'resume-token' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/uploads/upload-1', expect.objectContaining({
      method: 'GET',
      headers: { 'X-Upload-Token': 'resume-token', Authorization: 'Bearer admin-jwt' },
    }));
  });

  it('passes caller headers to DELETE while preserving the admin Authorization header', async () => {
    await api.delete('/uploads/upload-1', { 'X-Upload-Token': 'resume-token' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/uploads/upload-1', expect.objectContaining({
      method: 'DELETE',
      headers: { 'X-Upload-Token': 'resume-token', Authorization: 'Bearer admin-jwt' },
    }));
  });

  it('retains safe HTTP status and upload-state metadata for terminal-response handling', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVALID_UPLOAD_STATE', message: 'Cannot abort', current: 'completed' }),
    } as Response);

    await expect(api.delete('/uploads/upload-1', { 'X-Upload-Token': 'resume-token' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_UPLOAD_STATE',
      currentStatus: 'completed',
    });
  });
});
