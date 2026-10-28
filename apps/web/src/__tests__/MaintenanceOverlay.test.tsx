// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MaintenanceOverlay from '../components/MaintenanceOverlay';
import { ApiError, api } from '../lib/api';
import { maintenanceStore } from '../lib/maintenance';

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
  });

  afterEach(() => {
    cleanup();
    maintenanceStore.getState().reset();
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

  it('preserves an authentication failure as an auth error instead of clearing maintenance state', async () => {
    mockedApi.get.mockRejectedValue(new ApiError(401, 'Session expired', 'AUTH_REQUIRED'));

    render(<MaintenanceOverlay pollIntervalMs={20} />);
    act(() => maintenanceStore.getState().activate({
      status: 503,
      code: 'UPDATE_MAINTENANCE',
      retryAfterSeconds: 2,
    }));

    expect(await screen.findByText(/登录已过期/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(maintenanceStore.getState().active).toBe(true);
    expect(maintenanceStore.getState().code).toBe('UPDATE_MAINTENANCE');
  });
});
