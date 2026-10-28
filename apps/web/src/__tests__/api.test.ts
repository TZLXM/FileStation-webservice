import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { maintenanceStore } from '../lib/maintenance';

describe('upload API request headers and failures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const okResponse = { ok: true, status: 200, json: vi.fn(async () => ({ code: 'OK', data: {}, request_id: 'r1' })) };

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(okResponse as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    api.setAccessToken('admin-jwt');
    maintenanceStore.getState().reset();
  });

  afterEach(() => {
    api.setAccessToken(null);
    maintenanceStore.getState().reset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it('prefixes API requests with the canonical subpath base', async () => {
    vi.stubEnv('BASE_URL', '/fs/');

    await api.get('/settings');

    expect(fetchMock).toHaveBeenCalledWith('/fs/api/v1/settings', expect.objectContaining({
      method: 'GET',
    }));
  });

  it.each([
    ['GET', (signal: AbortSignal) => api.get('/uploads/upload-1', { 'X-Upload-Token': 'resume-token' }, signal)],
    ['POST', (signal: AbortSignal) => api.post('/uploads/upload-1/resume', undefined, { 'X-Upload-Token': 'resume-token' }, signal)],
    ['PUT', (signal: AbortSignal) => api.put('/uploads/upload-1/parts/0', new Blob(['part']), { 'X-Upload-Token': 'resume-token' }, signal)],
    ['DELETE', (signal: AbortSignal) => api.delete('/uploads/upload-1', { 'X-Upload-Token': 'resume-token' }, signal)],
  ])('%s forwards its optional AbortSignal without dropping caller headers', async (_method, invoke) => {
    const controller = new AbortController();

    await invoke(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/uploads/upload-1'), expect.objectContaining({
      signal: controller.signal,
      headers: expect.objectContaining({ 'X-Upload-Token': 'resume-token', Authorization: 'Bearer admin-jwt' }),
    }));
  });

  it('activates the global maintenance state only for an exact UPDATE_MAINTENANCE response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'Retry-After': '9' }),
      json: async () => ({
        code: 'UPDATE_MAINTENANCE',
        message: 'FileStation is temporarily unavailable while an update is prepared',
      }),
    } as Response);

    await expect(api.get('/settings')).rejects.toMatchObject({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 9,
    });

    expect(maintenanceStore.getState()).toMatchObject({
      active: true,
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 9,
    });
  });

  it.each([
    [401, 'UPDATE_MAINTENANCE'],
    [503, 'AUTH_BACKEND_UNAVAILABLE'],
    [503, 'UPDATE_BUSY'],
  ])('does not classify status=%s code=%s as maintenance', async (status, code) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      headers: new Headers(),
      json: async () => ({ code, message: 'Request failed' }),
    } as Response);

    await expect(api.get('/settings')).rejects.toBeInstanceOf(ApiError);

    expect(maintenanceStore.getState().active).toBe(false);
  });

  it('pauses ordinary requests during maintenance while retaining the read-only status poll', async () => {
    maintenanceStore.getState().activate({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 5,
    });
    fetchMock.mockClear();

    await expect(api.get('/settings')).rejects.toMatchObject({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await api.get('/updates/status');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/updates/status', expect.objectContaining({
      method: 'GET',
    }));
  });

  it('uses the canonical base helper for the maintenance status poll', async () => {
    vi.stubEnv('BASE_URL', '/fs/');
    maintenanceStore.getState().activate({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 5,
    });
    fetchMock.mockClear();

    await api.get('/updates/status');

    expect(fetchMock).toHaveBeenCalledWith('/fs/api/v1/updates/status', expect.objectContaining({
      method: 'GET',
    }));
  });
});
