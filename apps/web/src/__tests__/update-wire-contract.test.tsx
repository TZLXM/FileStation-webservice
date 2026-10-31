// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { ApiError, api } from '../lib/api';
import { maintenanceStore } from '../lib/maintenance';
import { useAuthStore } from '../stores/authStore';
import UpdateSection from '../pages/settings/UpdateSection';
import MaintenanceOverlay from '../components/MaintenanceOverlay';

// Raw fixtures mirror UpdateStatusController; no ApiClient or component mocks.
const status = {
  stage: 'idle', current_version: '0.2.5', available_version: null,
  decision: 'unavailable', phase: 'idle',
  capability: { mode: 'docker', supported: false, install_root: null,
    updater_version: null, platform: 'linux-x64', reason: 'DOCKER_MANUAL_UPGRADE' },
};
const available = { ...status, decision: 'available', available_version: '0.2.6',
  manifest_sha256: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64),
  capability: { ...status.capability, mode: 'managed', supported: true,
    install_root: '/srv/filestation', updater_version: '0.2.5', reason: null } };
const prepared = { prepared_id: 'receipt-01', version: '0.2.6' };
const accepted = { attempt_id: 'attempt-01', prepared_id: 'receipt-01', fence: 2, phase: 'PREPARED' };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), {
  status: code, headers: { 'Content-Type': 'application/json' },
});

describe('raw update HTTP contract through ApiClient and components', () => {
  beforeEach(() => {
    api.setAccessToken('synthetic-admin');
    useAuthStore.setState({ accessToken: 'synthetic-admin', isAuthenticated: true });
    maintenanceStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    api.setAccessToken(null);
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    maintenanceStore.getState().reset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['/', '/fs/'])('renders raw Docker status and check at base %s', async (base) => {
    vi.stubEnv('BASE_URL', base);
    const requests: string[] = [];
    const authorization: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      authorization.push(req.headers.authorization);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture TCP address');
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      nativeFetch(new URL(url, `http://127.0.0.1:${address.port}`), init));
    try {
      render(<UpdateSection totpActive={false} />);
      expect(await screen.findByRole('heading', { name: 'Docker 镜像升级' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
      await waitFor(() => expect(requests).toEqual([
        `GET ${base}api/v1/updates/status`, `POST ${base}api/v1/updates/check`,
      ]));
      await waitFor(() => expect(screen.getByRole('button', { name: '立即检查' })).toBeEnabled());
      expect(authorization).toEqual(['Bearer synthetic-admin', 'Bearer synthetic-admin']);
      expect(screen.queryByRole('button', { name: '下载并验证更新' })).not.toBeInTheDocument();
      expect(screen.queryByText('服务器未返回更新检查结果。')).not.toBeInTheDocument();
    } finally {
      cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('consumes raw check, receipt, acceptance and fenced terminal poll', async () => {
    let installed = false;
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (url.endsWith('/check')) return json(available);
      if (url.endsWith('/prepare')) return json(prepared, 201);
      if (url.endsWith('/install')) {
        expect(JSON.parse(String(init.body))).toEqual({ prepared_id: 'receipt-01', password: 'synthetic-password' });
        installed = true;
        return json(accepted, 202);
      }
      return json(installed ? { ...available, ...accepted, phase: 'COMMITTED', target_version: '0.2.6', fence: 3 } : status);
    });
    render(<UpdateSection totpActive={false} pollIntervalMs={5} />);
    await screen.findByRole('heading', { name: 'Docker 镜像升级' });
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
    fireEvent.click(await screen.findByRole('button', { name: '下载并验证更新' }));
    await screen.findByRole('dialog', { name: '确认安装更新' });
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    await screen.findByText('更新完成');
    expect(requests).toEqual([
      'GET /api/v1/updates/status', 'POST /api/v1/updates/check',
      'POST /api/v1/updates/prepare', 'POST /api/v1/updates/install',
      'GET /api/v1/updates/status',
    ]);
  });

  it('applies raw maintenance status then releases the overlay on terminal status', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', async () => json({ phase: ++polls === 1 ? 'MAINTENANCE' : 'COMMITTED',
      target_version: '0.2.6', attempt_id: 'attempt-01' }));
    maintenanceStore.getState().activate({ status: 503, code: 'UPDATE_MAINTENANCE' });
    render(<MaintenanceOverlay pollIntervalMs={100} />);
    expect(await screen.findByText('v0.2.6')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(maintenanceStore.getState().active).toBe(false);
  });

  it.each([401, 403, 409])('preserves raw endpoint HTTP %s errors without activating maintenance', async (code) => {
    vi.stubGlobal('fetch', async () => json({ code: 'UPDATE_REFUSED', message: 'Refused' }, code));
    await expect(api.postRaw('/updates/install', { prepared_id: 'receipt-01' }))
      .rejects.toMatchObject({ status: code, code: 'UPDATE_REFUSED', message: 'Refused' });
    expect(maintenanceStore.getState().active).toBe(false);
  });

  it('retains exact maintenance activation and blocks raw mutations while permitting status recovery', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return requests === 1
        ? new Response(JSON.stringify({ code: 'UPDATE_MAINTENANCE', message: 'Updating' }), {
          status: 503, headers: { 'Retry-After': '7', 'Content-Type': 'application/json' },
        })
        : json({ phase: 'COMMITTED' });
    });
    await expect(api.postRaw('/updates/check')).rejects.toMatchObject({ status: 503, retryAfterSeconds: 7 });
    expect(maintenanceStore.getState().active).toBe(true);
    await expect(api.postRaw('/updates/install')).rejects.toBeInstanceOf(ApiError);
    expect(requests).toBe(1);
    await expect(api.getRaw('/updates/status')).resolves.toEqual({ phase: 'COMMITTED' });
    expect(requests).toBe(2);
  });

  it('forwards raw request cancellation without triggering maintenance', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      expect(init.signal).toBe(controller.signal);
      init.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const pending = api.getRaw('/updates/status', undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(maintenanceStore.getState().active).toBe(false);
  });
});
