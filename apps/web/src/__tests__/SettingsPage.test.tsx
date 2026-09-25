// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const baseSettings = {
  site: { name: 'FileStation', icon: null, theme_color: '#2563eb' },
  security: { totp_required: false, totp_active: false, max_login_attempts: 5, lockout_minutes: 15 },
  transfer: { default_chunk_size: 4194304, global_upload_limit_bps: null, global_download_limit_bps: null },
  storage: { path: '/data', max_size_gb: 100, cleanup_grace_hours: 24, default_expire_hours: 168 },
};

describe('SettingsPage Phase 2 sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'test-token', username: 'alice' });
  });

  afterEach(cleanup);

  it('mounts token and agent sections, refreshes agent props, and preserves unrelated drafts', async () => {
    let savedAgent = { mcp_enabled: false, mcp_max_upload_mb: 32 };
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: savedAgent } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.put.mockImplementation(async (_path: string, body?: BodyInit | object) => {
      savedAgent = (body as { agent: typeof savedAgent }).agent;
      return { data: {} } as never;
    });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'API Token' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent 接入（MCP）' })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('FileStation'), { target: { value: 'Draft site name' } });
    fireEvent.click(screen.getByLabelText('启用 MCP 端点'));
    fireEvent.change(screen.getByLabelText('MCP 单文件大小上限（MB）'), { target: { value: '64' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }));

    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith('/settings'));
    await waitFor(() => expect(screen.getByLabelText('启用 MCP 端点')).toBeChecked());
    expect(screen.getByLabelText('MCP 单文件大小上限（MB）')).toHaveValue(64);
    expect(screen.getByDisplayValue('Draft site name')).toBeInTheDocument();
  });

  it('sends the TOTP requirement without the derived active flag and keeps a rejected choice visible', async () => {
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: { mcp_enabled: false, mcp_max_upload_mb: 32 } } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.put.mockRejectedValue(new Error('Enable TOTP for your account before requiring it'));

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    const required = await screen.findByLabelText('要求登录时使用 TOTP');
    fireEvent.click(required);
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enable TOTP for your account before requiring it');
    expect(required).toBeChecked();
    expect(mockedApi.put).toHaveBeenCalledWith('/settings', expect.objectContaining({
      security: expect.objectContaining({ totp_required: true }),
    }));
    expect((mockedApi.put.mock.calls[0][1] as { security: Record<string, unknown> }).security)
      .not.toHaveProperty('totp_active');
  });

  it('enables TOTP through the Task 8 setup and confirm contracts, then refreshes derived status', async () => {
    let totpActive = false;
    let resolveConfirm!: (response: unknown) => void;
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') {
        return { data: {
          ...baseSettings,
          security: { ...baseSettings.security, totp_active: totpActive },
          agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
        } } as never;
      }
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockImplementation(async (path: string) => {
      if (path === '/auth/totp/setup') {
        return { data: {
          secret: 'synthetic-secret-placeholder',
          otpauth_url: 'otpauth://totp/synthetic-placeholder',
          qr_code_data_url: 'data:image/png;base64,c3ludGhldGlj',
        } } as never;
      }
      if (path === '/auth/totp/confirm') {
        totpActive = true;
        return new Promise((resolve) => { resolveConfirm = resolve; }) as never;
      }
      return { data: null } as never;
    });
    mockedApi.put.mockRejectedValue(new Error('Enable TOTP for your account before requiring it'));

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    const required = await screen.findByLabelText('要求登录时使用 TOTP');
    fireEvent.click(required);
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enable TOTP for your account before requiring it');
    expect(required).toBeChecked();

    fireEvent.click(await screen.findByRole('button', { name: '启用 TOTP' }));
    expect(await screen.findByAltText('TOTP 设置二维码')).toHaveAttribute('src', 'data:image/png;base64,c3ludGhldGlj');
    expect(screen.getByText('synthetic-secret-placeholder')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('确认验证码'), { target: { value: '123456' } });
    const confirmForm = screen.getByRole('button', { name: '确认启用' }).closest('form')!;
    fireEvent.submit(confirmForm);
    fireEvent.submit(confirmForm);

    expect(mockedApi.post).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveConfirm({ data: null });
    });

    expect(await screen.findByText('已启用')).toBeInTheDocument();
    expect(screen.queryByText('synthetic-secret-placeholder')).not.toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenNthCalledWith(1, '/auth/totp/setup', {});
    expect(mockedApi.post).toHaveBeenNthCalledWith(2, '/auth/totp/confirm', { code: '123456' });
    expect(mockedApi.get).toHaveBeenCalledTimes(3);
    expect(required).toBeChecked();

    mockedApi.put.mockResolvedValue({ data: null } as never);
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByText('设置已保存。')).toBeInTheDocument();
    const savedSettings = mockedApi.put.mock.calls[1][1] as { security: Record<string, unknown> };
    expect(savedSettings.security).toMatchObject({ totp_required: true });
    expect(savedSettings.security).not.toHaveProperty('totp_active');
  });

  it('ignores an older TOTP status refresh that returns after a newer disable refresh', async () => {
    let activeOnServer = false;
    let settingsReads = 0;
    let resolveEnableRefresh!: (value: unknown) => void;
    let resolveDisableRefresh!: (value: unknown) => void;
    const settingsResponse = (active: boolean) => ({
      ...baseSettings,
      security: { ...baseSettings.security, totp_active: active },
      agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
    });
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') {
        settingsReads += 1;
        if (settingsReads === 1) return { data: settingsResponse(false) } as never;
        if (settingsReads === 2) return new Promise((resolve) => { resolveEnableRefresh = resolve; }) as never;
        if (settingsReads === 3) return new Promise((resolve) => { resolveDisableRefresh = resolve; }) as never;
      }
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockImplementation(async (path: string) => {
      if (path === '/auth/totp/setup') {
        return { data: {
          secret: 'race-secret-placeholder',
          otpauth_url: 'otpauth://totp/race-placeholder',
          qr_code_data_url: 'data:image/png;base64,cmFjZQ==',
        } } as never;
      }
      if (path === '/auth/totp/confirm') activeOnServer = true;
      if (path === '/auth/totp/disable') activeOnServer = false;
      return { data: null } as never;
    });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '启用 TOTP' }));
    fireEvent.change(await screen.findByLabelText('确认验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    expect(await screen.findByRole('button', { name: '停用 TOTP' })).toBeInTheDocument();
    await waitFor(() => expect(settingsReads).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: '停用 TOTP' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前验证码'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(settingsReads).toBe(3));

    await act(async () => resolveDisableRefresh({ data: settingsResponse(activeOnServer) }));
    expect(await screen.findByRole('button', { name: '启用 TOTP' })).toBeInTheDocument();
    await act(async () => resolveEnableRefresh({ data: settingsResponse(true) }));

    expect(screen.getByRole('button', { name: '启用 TOTP' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停用 TOTP' })).not.toBeInTheDocument();
  });

  it('does not surface a rejected TOTP refresh after a newer status refresh succeeds', async () => {
    let activeOnServer = false;
    let settingsReads = 0;
    let rejectEnableRefresh!: (error: Error) => void;
    const settingsResponse = (active: boolean) => ({
      ...baseSettings,
      security: { ...baseSettings.security, totp_active: active },
      agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
    });
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') {
        settingsReads += 1;
        if (settingsReads === 1) return { data: settingsResponse(false) } as never;
        if (settingsReads === 2) {
          return new Promise((_, reject) => { rejectEnableRefresh = reject; }) as never;
        }
        if (settingsReads === 3) return { data: settingsResponse(false) } as never;
      }
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockImplementation(async (path: string) => {
      if (path === '/auth/totp/setup') {
        return { data: {
          secret: 'refresh-error-secret-placeholder',
          otpauth_url: 'otpauth://totp/refresh-error-placeholder',
          qr_code_data_url: 'data:image/png;base64,ZXJyb3I=',
        } } as never;
      }
      if (path === '/auth/totp/confirm') activeOnServer = true;
      if (path === '/auth/totp/disable') activeOnServer = false;
      return { data: null } as never;
    });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '启用 TOTP' }));
    fireEvent.change(await screen.findByLabelText('确认验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    expect(await screen.findByRole('button', { name: '停用 TOTP' })).toBeInTheDocument();
    await waitFor(() => expect(settingsReads).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: '停用 TOTP' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前验证码'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(settingsReads).toBe(3));
    expect(await screen.findByRole('button', { name: '启用 TOTP' })).toBeInTheDocument();

    await act(async () => rejectEnableRefresh(new Error('stale-refresh-error-placeholder')));

    expect(screen.getByRole('button', { name: '启用 TOTP' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('TOTP 已停用');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the setup instructions visible when the confirmation code is rejected', async () => {
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: { mcp_enabled: false, mcp_max_upload_mb: 32 } } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        secret: 'temporary-secret-placeholder',
        otpauth_url: 'otpauth://totp/temporary-placeholder',
        qr_code_data_url: 'data:image/png;base64,c3ludGhldGlj',
      } } as never)
      .mockRejectedValueOnce(new Error('验证码错误'));

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '启用 TOTP' }));
    await screen.findByAltText('TOTP 设置二维码');
    fireEvent.change(screen.getByLabelText('确认验证码'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误');
    expect(screen.getByText('temporary-secret-placeholder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认启用' })).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale setup response without unlocking a newer setup request', async () => {
    let resolveFirstSetup!: (value: unknown) => void;
    let resolveSecondSetup!: (value: unknown) => void;
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: { mcp_enabled: false, mcp_max_upload_mb: 32 } } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstSetup = resolve; }) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondSetup = resolve; }) as never);

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    const setupButton = await screen.findByRole('button', { name: '启用 TOTP' });
    fireEvent.click(setupButton);
    fireEvent.click(await screen.findByRole('button', { name: '取消初始化' }));
    fireEvent.click(screen.getByRole('button', { name: '启用 TOTP' }));

    await act(async () => {
      resolveFirstSetup({ data: {
        secret: 'stale-secret-placeholder',
        otpauth_url: 'otpauth://totp/stale-placeholder',
        qr_code_data_url: 'data:image/png;base64,c3RhbGU=',
      } });
    });
    expect(screen.getByRole('button', { name: '正在准备二维码…' })).toBeDisabled();
    expect(screen.queryByText('stale-secret-placeholder')).not.toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecondSetup({ data: {
        secret: 'current-secret-placeholder',
        otpauth_url: 'otpauth://totp/current-placeholder',
        qr_code_data_url: 'data:image/png;base64,Y3VycmVudA==',
      } });
    });
    expect(screen.getByText('current-secret-placeholder')).toBeInTheDocument();
    expect(screen.queryByText('stale-secret-placeholder')).not.toBeInTheDocument();
  });

  it('disables TOTP with the current password and code, then refreshes status', async () => {
    let totpActive = true;
    let resolveDisable!: (response: unknown) => void;
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') {
        return { data: {
          ...baseSettings,
          security: { ...baseSettings.security, totp_active: totpActive },
          agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
        } } as never;
      }
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockImplementation(async (path: string) => {
      if (path === '/auth/totp/disable') {
        return new Promise((resolve) => {
          resolveDisable = (response) => {
            totpActive = false;
            resolve(response);
          };
        }) as never;
      }
      return { data: null } as never;
    });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '停用 TOTP' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前验证码'), { target: { value: '654321' } });
    const disableForm = screen.getByRole('button', { name: '确认停用' }).closest('form')!;
    fireEvent.submit(disableForm);
    fireEvent.submit(disableForm);

    expect(mockedApi.post).toHaveBeenCalledTimes(1);
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/totp/disable', {
      password: 'password-placeholder', code: '654321',
    });
    await act(async () => resolveDisable({ data: null }));
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('button', { name: '启用 TOTP' })).toBeInTheDocument();
  });

  it('uses narrow-screen responsive layout contracts for TOTP setup content', async () => {
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: { mcp_enabled: false, mcp_max_upload_mb: 32 } } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockResolvedValue({ data: {
      secret: 'responsive-secret-placeholder',
      otpauth_url: 'otpauth://totp/responsive-placeholder',
      qr_code_data_url: 'data:image/png;base64,c21hbGw=',
    } } as never);

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '启用 TOTP' }));
    const qr = await screen.findByAltText('TOTP 设置二维码');
    expect(qr.parentElement).toHaveClass('flex-col', 'sm:flex-row', 'min-w-0');
    expect(qr).toHaveClass('max-w-full');
    expect(screen.getByRole('button', { name: '确认启用' }).parentElement).toHaveClass('flex-col', 'sm:flex-row');
  });

  it('keeps the disable form available when the server rejects the password or code', async () => {
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return {
        data: {
          ...baseSettings,
          security: { ...baseSettings.security, totp_active: true },
          agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
        },
      } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.post.mockRejectedValue(new Error('验证失败'));

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '停用 TOTP' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前验证码'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('验证失败');
    expect(screen.getByLabelText('当前密码')).toHaveValue('password-placeholder');
    expect(screen.getByLabelText('当前验证码')).toHaveValue('654321');
  });
});
