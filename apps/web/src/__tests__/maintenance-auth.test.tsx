// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MaintenanceOverlay from '../components/MaintenanceOverlay';
import { api } from '../lib/api';
import { maintenanceStore } from '../lib/maintenance';
import { useAuthStore } from '../stores/authStore';

const maintenance = { status: 503, code: 'UPDATE_MAINTENANCE' };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 'OK', data }), { status: 200 });
const blocked = () => new Response(JSON.stringify({ code: 'UPDATE_MAINTENANCE' }), { status: 503 });
beforeEach(() => {
  api.setAccessToken(null);
  useAuthStore.setState({ accessToken: null, isAuthenticated: false, username: null });
  maintenanceStore.getState().reset();
});
afterEach(() => {
  cleanup();
  api.setAccessToken(null);
  useAuthStore.setState({ accessToken: null, isAuthenticated: false, username: null });
  maintenanceStore.getState().reset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['/', '/fs/'])('anonymous recovery uses existing public readiness under %s', async (base) => {
  vi.stubEnv('BASE_URL', base);
  const fetcher = vi.fn().mockResolvedValueOnce(blocked())
    .mockResolvedValueOnce(ok({ initialized: true })).mockResolvedValue(ok({ files: [] }));
  vi.stubGlobal('fetch', fetcher);
  maintenanceStore.getState().activate(maintenance);
  render(<MaintenanceOverlay pollIntervalMs={5} />);
  await waitFor(() => expect(maintenanceStore.getState().active).toBe(false));
  await api.get('/shares/public');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${base}api/v1/auth/status`, `${base}api/v1/auth/status`, `${base}api/v1/shares/public`,
  ]);
});

it('expired auth switches to readiness even when maintenance persists, then permits refresh/login', async () => {
  useAuthStore.getState().login('expired-session', 'admin');
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), { status: 401 }))
    .mockResolvedValueOnce(blocked())
    .mockResolvedValueOnce(ok({ initialized: true }))
    .mockResolvedValueOnce(ok({ access_token: 'renewed-session', username: 'admin' }));
  vi.stubGlobal('fetch', fetcher);
  maintenanceStore.getState().activate(maintenance);
  render(<MaintenanceOverlay pollIntervalMs={5} />);
  await waitFor(() => expect(maintenanceStore.getState().active).toBe(false));
  await act(async () => { expect(await useAuthStore.getState().checkAuth()).toBe(true); });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/updates/status', '/api/v1/auth/status', '/api/v1/auth/status', '/api/v1/auth/refresh',
  ]);
  expect(useAuthStore.getState().accessToken).toBe('renewed-session');
});

it('logout reaches cookie revocation, retires the old poll, and ignores its late maintenance response', async () => {
  useAuthStore.getState().login('active-session', 'admin');
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValue(ok(null));
  vi.stubGlobal('fetch', fetcher);
  maintenanceStore.getState().activate(maintenance);
  render(<MaintenanceOverlay pollIntervalMs={1000} />);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  await act(async () => { await useAuthStore.getState().logout(); });
  expect(fetcher.mock.calls[1][0]).toBe('/api/v1/auth/logout');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(blocked()));
  expect(maintenanceStore.getState().active).toBe(false);
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(api.getAccessToken()).toBeNull();
});
