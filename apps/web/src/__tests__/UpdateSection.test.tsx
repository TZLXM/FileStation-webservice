// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import UpdateSection from '../pages/settings/UpdateSection';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    getRaw: vi.fn(),
    postRaw: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

function response<T>(data: T) {
  return data;
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'idle',
    current_version: '0.2.0',
    available_version: null,
    candidate_commit: null,
    progress_percent: null,
    error_code: null,
    message: null,
    checked_at: null,
    decision: 'same_version',
    publisher_status: 'configured',
    capability: {
      mode: 'managed',
      supported: true,
      install_root: '/srv/filestation',
      updater_version: '0.2.0',
      platform: 'linux-x64',
      reason: null,
    },
    updater_version: '0.2.0',
    manifest_sha256: null,
    artifact_sha256: null,
    artifact_filename: null,
    archive_size: null,
    unpacked_size: null,
    release_summaries: null,
    release_notes_url: null,
    upgrade_guide_url: null,
    phase: 'idle',
    target_version: undefined,
    updated_at: undefined,
    ...overrides,
  };
}

const available = status({
  decision: 'available',
  available_version: '0.2.5',
  checked_at: '2026-10-28T08:00:00.000Z',
  manifest_sha256: 'a'.repeat(64),
  artifact_sha256: 'b'.repeat(64),
  release_summaries: {
    'zh-CN': {
      features: [{ id: 'feature-zh', text: '新增发布自动化' }],
      fixes: [],
    },
    en: {
      features: [{ id: 'feature-en', text: 'Adds release automation' }],
      security: [{ id: 'security-en', text: 'Tightens update verification' }],
    },
  },
});

const prepared = {
  prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
  manifest_sha256: 'a'.repeat(64),
  artifact_sha256: 'b'.repeat(64),
  version: '0.2.5',
  platform: 'linux-x64',
  arch: 'x64',
  staging_path: '/srv/filestation/stage/payload',
  verified_size: 1024,
  unpacked_size: 4096,
  expires_at: Date.now() + 60_000,
};

const accepted = {
  attempt_id: 'attempt-01',
  prepared_id: prepared.prepared_id,
  fence: 2,
  phase: 'PREPARED',
  accepted_at: '2026-10-28T08:01:00.000Z',
};

async function openConfirmation(totpActive = false) {
  render(<UpdateSection totpActive={totpActive} pollIntervalMs={5} />);
  fireEvent.click(await screen.findByRole('button', { name: '下载并验证更新' }));
  await screen.findByRole('dialog', { name: '确认安装更新' });
}

describe('UpdateSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getRaw.mockResolvedValue(response(status()));
    mockedApi.postRaw.mockImplementation(async (path: string) => {
      if (path === '/updates/prepare') return response(prepared);
      if (path === '/updates/install') return response(accepted);
      if (path === '/updates/check') return response(status());
      return response(null);
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
  });

  it('shows current and latest versions when no stable update is available', async () => {
    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByText('当前版本')).toBeInTheDocument();
    expect(screen.getByText('最新稳定版')).toBeInTheDocument();
    expect(screen.getAllByText('v0.2.0')).toHaveLength(2);
    expect(screen.getByText('已是最新版本')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载并验证更新' })).not.toBeInTheDocument();
  });

  it('shows bilingual release sections, risk, checked time, and omits empty categories', async () => {
    mockedApi.getRaw.mockResolvedValue(response(available));

    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByText('v0.2.5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '中文发布说明' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'English release notes' })).toBeInTheDocument();
    expect(screen.getByText('新增发布自动化')).toBeInTheDocument();
    expect(screen.getByText('Adds release automation')).toBeInTheDocument();
    expect(screen.getByText('Tightens update verification')).toBeInTheDocument();
    expect(screen.queryByText('问题修复')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '风险与迁移注意事项' })).toBeInTheDocument();
    expect(screen.getByText(/上次检查/)).toBeInTheDocument();
  });

  it.each([
    ['unavailable', 'unmanaged', 'UNMANAGED_INSTALL'],
    ['manual_bootstrap', 'managed', null],
  ])('shows bootstrap guidance for the real unmanaged response and migration decision %s', async (decision, mode, reason) => {
    mockedApi.getRaw.mockResolvedValue(response(status({
      decision,
      stage: decision === 'unavailable' ? 'failed' : 'idle',
      available_version: decision === 'unavailable' ? null : '0.2.5',
      error_code: reason,
      message: decision === 'unavailable' ? 'Automatic updates require a managed FileStation installation' : null,
      capability: {
        mode,
        supported: mode === 'managed',
        install_root: mode === 'managed' ? '/srv/filestation' : null,
        updater_version: mode === 'managed' ? '0.2.0' : null,
        platform: 'linux-x64',
        reason,
      },
    })));

    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByRole('heading', { name: '需要手动 bootstrap' })).toBeInTheDocument();
    expect(screen.getByText(/managed installation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载并验证更新' })).not.toBeInTheDocument();
  });

  it('shows Docker image upgrade instructions and never offers an in-container update', async () => {
    mockedApi.getRaw.mockResolvedValue(response(status({
      decision: 'unavailable',
      capability: {
        mode: 'docker',
        supported: false,
        install_root: null,
        updater_version: null,
        platform: 'linux-x64',
        reason: 'DOCKER_MANUAL_UPGRADE',
      },
      message: 'Update the container image through the Docker deployment workflow',
    })));

    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByRole('heading', { name: 'Docker 镜像升级' })).toBeInTheDocument();
    expect(screen.getByText(/pull.*image/i)).toBeInTheDocument();
    expect(screen.getByText(/container 内自更新/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载并验证更新' })).not.toBeInTheDocument();
  });

  it('shows unsupported platform capability and the observed platform', async () => {
    mockedApi.getRaw.mockResolvedValue(response(status({
      decision: 'unsupported_platform',
      capability: {
        mode: 'unsupported',
        supported: false,
        install_root: null,
        updater_version: null,
        platform: 'freebsd-x64',
        reason: 'UNSUPPORTED_PLATFORM',
      },
    })));

    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByRole('heading', { name: '当前平台不支持自动更新' })).toBeInTheDocument();
    expect(screen.getByText(/freebsd-x64/)).toBeInTheDocument();
    expect(screen.getByText(/Windows x64.*Linux x64/)).toBeInTheDocument();
  });

  it('shows an unavailable capability with the last error and retries the check', async () => {
    const failed = status({
      stage: 'failed',
      decision: 'unavailable',
      error_code: 'PUBLISHER_UNCONFIGURED',
      message: 'Update publisher key is not configured',
      capability: {
        mode: 'unavailable',
        supported: false,
        install_root: null,
        updater_version: null,
        platform: 'linux-x64',
        reason: 'PUBLISHER_UNCONFIGURED',
      },
    });
    mockedApi.getRaw.mockResolvedValue(response(failed));
    mockedApi.postRaw.mockResolvedValueOnce(response(status({
      decision: 'same_version',
      checked_at: '2026-10-28T08:00:00.000Z',
    })));

    render(<UpdateSection totpActive={false} />);

    expect(await screen.findByText('Update publisher key is not configured')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
    await waitFor(() => expect(mockedApi.postRaw).toHaveBeenCalledWith('/updates/check', { force: true }));
    expect(await screen.findByText('已是最新版本')).toBeInTheDocument();
  });

  it('prevents duplicate preparation and sends the exact signed selection', async () => {
    let finishPrepare!: (value: unknown) => void;
    mockedApi.getRaw.mockResolvedValue(response(available));
    mockedApi.postRaw.mockImplementation((path: string) => {
      if (path === '/updates/prepare') {
        return new Promise((resolve) => {
          finishPrepare = resolve;
        }) as never;
      }
      return Promise.resolve(response(null)) as never;
    });

    render(<UpdateSection totpActive={false} pollIntervalMs={5} />);
    const prepare = await screen.findByRole('button', { name: '下载并验证更新' });
    fireEvent.click(prepare);
    fireEvent.click(prepare);

    expect(screen.getByRole('button', { name: '正在下载并验证…' })).toBeDisabled();
    expect(mockedApi.postRaw).toHaveBeenCalledTimes(1);
    expect(mockedApi.postRaw).toHaveBeenCalledWith('/updates/prepare', {
      version: '0.2.5',
      manifest_sha256: 'a'.repeat(64),
      artifact_sha256: 'b'.repeat(64),
    });

    await act(async () => finishPrepare(response(prepared)));
    expect(await screen.findByRole('dialog', { name: '确认安装更新' })).toBeInTheDocument();
  });

  it.each([
    [false, false],
    [true, true],
  ])('requires a password and conditionally TOTP when active=%s', async (totpActive, expectsTotp) => {
    mockedApi.getRaw.mockResolvedValueOnce(response(available))
      .mockResolvedValue(response(status({
        phase: 'MAINTENANCE',
        attempt_id: 'attempt-01',
        fence: 2,
        target_version: '0.2.5',
      })));
    await openConfirmation(totpActive);

    expect(screen.getByLabelText('当前密码')).toHaveAttribute('type', 'password');
    if (expectsTotp) {
      expect(screen.getByLabelText('当前 6 位 TOTP 验证码')).toBeInTheDocument();
    } else {
      expect(screen.queryByLabelText('当前 6 位 TOTP 验证码')).not.toBeInTheDocument();
    }

    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'component-local-password' },
    });
    if (expectsTotp) {
      fireEvent.change(screen.getByLabelText('当前 6 位 TOTP 验证码'), {
        target: { value: '123456' },
      });
    }
    const form = screen.getByRole('button', { name: '确认安装' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(mockedApi.postRaw).toHaveBeenCalledWith('/updates/install', expectsTotp
      ? {
        prepared_id: prepared.prepared_id,
        password: 'component-local-password',
        totp_code: '123456',
      }
      : {
        prepared_id: prepared.prepared_id,
        password: 'component-local-password',
      });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('更新安装已开始')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem('update-password')).toBeNull();
  });

  it('clears password and TOTP component state when confirmation is closed', async () => {
    mockedApi.getRaw.mockResolvedValue(response(available));
    await openConfirmation(true);

    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'must-clear-on-close' },
    });
    fireEvent.change(screen.getByLabelText('当前 6 位 TOTP 验证码'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '安装已准备好的更新' }));
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('当前 6 位 TOTP 验证码')).toHaveValue('');
  });

  it('clears rejected credentials after a failed confirmation and leaves the dialog recoverable', async () => {
    mockedApi.getRaw.mockResolvedValue(response(available));
    mockedApi.postRaw.mockImplementation(async (path: string) => {
      if (path === '/updates/prepare') return response(prepared);
      if (path === '/updates/install') throw new Error('The current password is invalid');
      return response(null);
    });
    await openConfirmation(false);

    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'rejected-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The current password is invalid');
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    ['FAILED', '更新失败'],
    ['ROLLED_BACK', '更新失败，已回滚到当前版本'],
    ['COMMITTED', '更新完成'],
  ])('polls a 202 attempt through %s and shows the terminal message', async (phase, message) => {
    const statuses = [
      response(available),
      response(status({ phase: 'MAINTENANCE', attempt_id: 'attempt-01', fence: 2, target_version: '0.2.5' })),
      response(status({ phase, attempt_id: 'attempt-01', fence: 2, target_version: '0.2.5' })),
    ];
    mockedApi.getRaw.mockImplementation(async () => statuses.shift()!);

    await openConfirmation(false);
    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'component-local-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));

    expect(await screen.findByText(message, {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByText(/attempt-01/)).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.getRaw.mock.calls.filter(([path]) => path === '/updates/status').length)
      .toBeGreaterThanOrEqual(3));
  });
  it.each([
    ['other-attempt', 2],
    ['attempt-01', 1],
    [undefined, undefined],
  ])('does not attribute a mismatching terminal journal %s/%s to the accepted install', async (attempt_id, fence) => {
    mockedApi.getRaw.mockResolvedValueOnce(response(available))
      .mockResolvedValue(response(status({ phase: 'COMMITTED', attempt_id, fence })));
    await openConfirmation();
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'local-password' } });
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    expect(await screen.findByText(/更新尝试已被替代或身份无法确认/)).toBeInTheDocument();
    expect(screen.queryByText('更新完成')).not.toBeInTheDocument();
    const calls = mockedApi.getRaw.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockedApi.getRaw).toHaveBeenCalledTimes(calls);
  });
  it.each([['committed', '更新完成'], ['rolledBack', '更新失败，已回滚到当前版本']])('follows actual server projection through same-attempt fence advancement to %s', async (terminal, message) => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(process.cwd(), 'src/__tests__/fixtures/update-status-projection.cjs')], { windowsHide: true });
    const projected = JSON.parse(stdout);
    const sequence = [available, ...[projected.maintenance, projected.handoff, projected[terminal]].map(value => status(value))];
    mockedApi.getRaw.mockImplementation(async () => response(sequence.shift()!));
    await openConfirmation();
    fireEvent.change(screen.getByLabelText('当前密码'), {target:{value:'fixture-password'}});
    fireEvent.click(screen.getByRole('button', {name:'确认安装'}));
    expect(await screen.findByText(message, {}, {timeout:2000})).toBeInTheDocument();
    expect(screen.queryByText(/更新尝试已被替代/)).not.toBeInTheDocument();
    expect(mockedApi.getRaw).toHaveBeenCalledTimes(4);
  }, 30000);

  it.each([
    {attempt_id:'other-attempt',fence:3,target_version:'0.2.5'},
    {attempt_id:'attempt-01',fence:2,target_version:'0.2.5'},
    {attempt_id:'attempt-01',fence:undefined,target_version:'0.2.5'},
    {attempt_id:'attempt-01',fence:3,target_version:undefined},
    {attempt_id:'attempt-01',fence:3,target_version:'0.2.6'},
  ])('rejects missing/mismatched identity, target or regressing fence after ownership transfer: %j', async terminal => {
    const sequence = [available, status({phase:'OLD_STOPPED',attempt_id:'attempt-01',fence:3,target_version:'0.2.5'}), status({phase:'COMMITTED',...terminal})];
    mockedApi.getRaw.mockImplementation(async()=>response(sequence.shift()!));
    await openConfirmation();
    fireEvent.change(screen.getByLabelText('当前密码'), {target:{value:'fixture-password'}});
    fireEvent.click(screen.getByRole('button', {name:'确认安装'}));
    expect(await screen.findByText(/更新尝试已被替代或身份无法确认/)).toBeInTheDocument();
    expect(screen.queryByText('更新完成')).not.toBeInTheDocument();
    expect(mockedApi.getRaw).toHaveBeenCalledTimes(3);
  });

  it('retires accepted install polling when the login session changes', async () => {
    let finish!: (value: unknown) => void;
    mockedApi.getRaw.mockResolvedValueOnce(response(available))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
    await openConfirmation();
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'local-password' } });
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    await screen.findByText('更新安装已开始');
    const signal = mockedApi.getRaw.mock.calls[1][2]!;
    act(() => useAuthStore.setState({ accessToken: 'different-session' }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(response(status({ phase: 'COMMITTED', attempt_id: 'attempt-01', fence: 2 }))));
    expect(screen.queryByText('更新完成')).not.toBeInTheDocument();
    expect(screen.getByText(/登录会话已变化/)).toBeInTheDocument();
    expect(mockedApi.getRaw).toHaveBeenCalledTimes(2);
  });
});
