// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MaintenanceOverlay from '../components/MaintenanceOverlay';
import { ApiError, api } from '../lib/api';
import { maintenanceStore } from '../lib/maintenance';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

function response<T>(data: T) {
  return { code: 'OK', data, request_id: 'test-request' } as never;
}

describe('MaintenanceOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maintenanceStore.getState().reset();
    useAuthStore.setState({ accessToken: 'admin-session', isAuthenticated: true });
  });

  afterEach(() => {
    cleanup();
    maintenanceStore.getState().reset();
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
  });

  it('opens from the global store, polls the read-only status route, and shows target/retry state', async () => {
    mockedApi.get.mockResolvedValue(response({
      phase: 'MAINTENANCE',
      attempt_id: 'attempt-01',
      target_version: '0.2.5',
      current_version: '0.2.0',
      updated_at: '2026-10-28T08:00:00.000Z',
    }));

    render(<MaintenanceOverlay pollIntervalMs={20} />);
    act(() => {
      maintenanceStore.getState().activate({
        status: 503,
        code: 'UPDATE_MAINTENANCE',
        message: 'FileStation is temporarily unavailable',
        retryAfterSeconds: 7,
      });
    });

    const dialog = screen.getByRole('alertdialog', { name: '系统维护中' });
    expect(dialog).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledWith('/updates/status', undefined, expect.any(AbortSignal));
    await waitFor(() => expect(within(dialog).getByText('v0.2.5')).toBeInTheDocument());
    expect(within(dialog).getByText('目标版本')).toBeInTheDocument();
    expect(screen.getByText(/每 7 秒/)).toBeInTheDocument();
    expect(screen.getByText(/attempt-01/)).toBeInTheDocument();
  });

  it('closes only after a terminal update status', async () => {
    mockedApi.get
      .mockResolvedValueOnce(response({ phase: 'MAINTENANCE', target_version: '0.2.5' }))
      .mockResolvedValueOnce(response({ phase: 'COMMITTED', target_version: '0.2.5' }));

    render(<MaintenanceOverlay pollIntervalMs={5} />);
    act(() => maintenanceStore.getState().activate({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 1,
    }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), {
      timeout: 2_000,
    });
    expect(mockedApi.get).toHaveBeenCalledTimes(2);
    expect(maintenanceStore.getState().active).toBe(false);
  });

  it('recovers an expired session through public readiness without exposing admin status', async () => {
    mockedApi.get.mockImplementation(async (path) => {
      if (path === '/updates/status') throw new ApiError(401, 'Session expired', 'AUTH_REQUIRED');
      return response({ initialized: true });
    });

    render(<MaintenanceOverlay pollIntervalMs={20} />);
    act(() => maintenanceStore.getState().activate({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 2,
    }));

    await waitFor(() => expect(maintenanceStore.getState().active).toBe(false));
    expect(mockedApi.get.mock.calls.map(([path]) => path)).toEqual(['/updates/status', '/auth/status']);
  });
  it('lets an anonymous share visitor recover after public readiness returns', async () => {
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    mockedApi.get.mockRejectedValueOnce(new ApiError(503, 'Maintenance', 'UPDATE_MAINTENANCE'))
      .mockResolvedValue(response({ initialized: true }));
    maintenanceStore.getState().activate({ status: 503, code: 'UPDATE_MAINTENANCE' });
    render(<MaintenanceOverlay pollIntervalMs={5} />);
    await waitFor(() => expect(maintenanceStore.getState().active).toBe(false));
    expect(mockedApi.get.mock.calls.map(([path]) => path)).toEqual(['/auth/status', '/auth/status']);
  });
  it('retires pending status polling when the session changes and ignores the old result', async () => {
    let finish!: (value: unknown) => void;
    mockedApi.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never)
      .mockResolvedValue(response({ phase: 'MAINTENANCE', attempt_id: 'new-session-attempt' }));
    maintenanceStore.getState().activate({ status: 503, code: 'UPDATE_MAINTENANCE' });
    render(<MaintenanceOverlay pollIntervalMs={1000} />);
    const oldSignal = mockedApi.get.mock.calls[0][2]!;
    act(() => useAuthStore.setState({ accessToken: 'replacement-session' }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(response({ phase: 'COMMITTED' })));
    expect(maintenanceStore.getState().active).toBe(true);
    expect(await screen.findByText('new-session-attempt')).toBeInTheDocument();
  });
});
