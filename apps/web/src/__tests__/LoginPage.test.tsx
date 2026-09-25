// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(), setAccessToken: vi.fn(), getAccessToken: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const challengeOne = 'challenge-placeholder-one';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>首页已加载</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitPassword() {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-placeholder' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
}

async function openRecoveryMode() {
  fireEvent.click(await screen.findByRole('button', { name: '无法使用验证器？使用恢复码登录' }));
}

describe('LoginPage TOTP flow', () => {
  let login: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    login = vi.fn();
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      username: null,
      login,
      logout: vi.fn(),
      setAccessToken: vi.fn(),
      checkAuth: vi.fn().mockResolvedValue(false),
    });
  });

  afterEach(cleanup);

  it('uses the one-time challenge and completes login with the returned username', async () => {
    mockedApi.post
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } } as never)
      .mockResolvedValueOnce({ data: { access_token: 'access-placeholder', expires_in: 900, username: 'alice' } } as never);
    renderLogin();

    await submitPassword();
    const codeInput = await screen.findByLabelText('验证器验证码');
    expect(screen.getByText('FileStation').parentElement?.parentElement)
      .toHaveClass('max-w-md', 'w-full', 'p-6', 'sm:p-8');
    expect(codeInput).toHaveAttribute('inputmode', 'numeric');
    expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenNthCalledWith(1, '/auth/login', {
      username: 'alice', password: 'password-placeholder',
    });
    expect(mockedApi.post).toHaveBeenNthCalledWith(2, '/auth/login/totp', {
      login_challenge: challengeOne, totp_code: '123456',
    });
    expect(login).toHaveBeenCalledWith('access-placeholder', 'alice');
  });

  it('discards a consumed challenge after a wrong code and starts a fresh password step', async () => {
    mockedApi.post
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } } as never)
      .mockRejectedValueOnce(new Error('验证码无效'))
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: 'challenge-placeholder-two', available_methods: ['totp'] } } as never)
      .mockResolvedValueOnce({ data: { access_token: 'fresh-access-placeholder', expires_in: 900, username: 'alice' } } as never);
    renderLogin();

    await submitPassword();
    fireEvent.change(await screen.findByLabelText('验证器验证码'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('验证码无效');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(screen.queryByLabelText('验证器验证码')).not.toBeInTheDocument();

    await submitPassword();
    expect(await screen.findByLabelText('验证器验证码')).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenNthCalledWith(3, '/auth/login', {
      username: 'alice', password: 'password-placeholder',
    });
    fireEvent.change(screen.getByLabelText('验证器验证码'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenNthCalledWith(4, '/auth/login/totp', {
      login_challenge: 'challenge-placeholder-two', totp_code: '111111',
    });
    expect(login).toHaveBeenCalledWith('fresh-access-placeholder', 'alice');
  });

  it('keeps password mode switching disabled until the cookie-setting password response settles', async () => {
    let resolvePasswordLogin!: (value: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolvePasswordLogin = resolve; }) as never);
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const recoveryEntry = screen.getByRole('button', { name: '无法使用验证器？使用恢复码登录' });
    expect(recoveryEntry).toBeDisabled();
    fireEvent.click(recoveryEntry);
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.queryByLabelText('恢复码')).not.toBeInTheDocument();

    await act(async () => resolvePasswordLogin({ data: {
      access_token: 'password-access-placeholder', expires_in: 86400,
    } }));
    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith('password-access-placeholder', 'alice');
  });

  it('keeps both TOTP mode switches disabled until the cookie-setting verification settles', async () => {
    let resolveVerification!: (value: unknown) => void;
    mockedApi.post
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveVerification = resolve; }) as never);
    renderLogin();

    await submitPassword();
    fireEvent.change(await screen.findByLabelText('验证器验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));

    const returnButton = screen.getByRole('button', { name: '返回账号登录' });
    const recoveryEntry = screen.getByRole('button', { name: '无法使用验证器？使用恢复码登录' });
    expect(returnButton).toBeDisabled();
    expect(recoveryEntry).toBeDisabled();
    fireEvent.click(returnButton);
    fireEvent.click(recoveryEntry);
    expect(screen.getByLabelText('验证器验证码')).toBeInTheDocument();

    await act(async () => {
      resolveVerification({ data: { access_token: 'totp-access-placeholder', expires_in: 900, username: 'alice' } });
    });
    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith('totp-access-placeholder', 'alice');
  });

  it('does not send duplicate password requests when submit fires twice before the first response', async () => {
    let resolveLogin!: (value: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolveLogin = resolve; }) as never);
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-placeholder' } });
    const form = screen.getByRole('button', { name: '登录' }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(mockedApi.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLogin({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } });
    });
    expect(await screen.findByLabelText('验证器验证码')).toBeInTheDocument();
  });

  it('uses the recovery DTO and completes login with the server-returned identity', async () => {
    mockedApi.post.mockResolvedValue({
      data: { access_token: 'recovery-access-placeholder', expires_in: 86400, username: 'alice' },
    } as never);
    renderLogin();
    await openRecoveryMode();
    expect(screen.getByLabelText('用户名')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('恢复码'), { target: { value: 'ABCD-EFGH-JK' } });
    fireEvent.click(screen.getByRole('button', { name: '使用恢复码登录' }));

    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/recovery/verify', {
      username: 'alice', code: 'ABCD-EFGH-JK',
    });
    expect(login).toHaveBeenCalledWith('recovery-access-placeholder', 'alice');
  });

  it('uses the same generic error for every recovery verification failure', async () => {
    mockedApi.post.mockRejectedValue(new Error('account and recovery code details must stay hidden'));
    renderLogin();
    await openRecoveryMode();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('恢复码'), { target: { value: 'ABCD-EFGH-JK' } });
    fireEvent.click(screen.getByRole('button', { name: '使用恢复码登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('恢复登录失败，请核对用户名和恢复码，或稍后重试。');
    expect(screen.queryByText('account and recovery code details must stay hidden')).not.toBeInTheDocument();
    expect(screen.getByLabelText('恢复码')).toHaveValue('');
    expect(login).not.toHaveBeenCalled();
  });

  it('clears passwords, codes, challenges, and errors when switching login modes', async () => {
    mockedApi.post
      .mockRejectedValueOnce(new Error('password failure placeholder'))
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } } as never);
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'first-password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('password failure placeholder');
    await openRecoveryMode();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('恢复码'), { target: { value: 'ABCD-EFGH-JK' } });
    fireEvent.click(screen.getByRole('button', { name: '返回账号登录' }));
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(screen.queryByLabelText('恢复码')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'second-password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByLabelText('验证器验证码');
    fireEvent.change(screen.getByLabelText('验证器验证码'), { target: { value: '123456' } });
    await openRecoveryMode();
    expect(screen.queryByLabelText('验证器验证码')).not.toBeInTheDocument();
    expect(screen.getByLabelText('恢复码')).toHaveValue('');
    expect(screen.getByLabelText('用户名')).toHaveValue('alice');
    expect(mockedApi.post).toHaveBeenCalledTimes(2);
  });

  it('keeps recovery mode locked until the cookie-setting recovery response settles', async () => {
    let resolveRecovery!: (response: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolveRecovery = resolve; }) as never);
    renderLogin();
    await openRecoveryMode();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('恢复码'), { target: { value: 'ABCD-EFGH-JK' } });
    const form = screen.getByRole('button', { name: '使用恢复码登录' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mockedApi.post).toHaveBeenCalledTimes(1);

    const returnButton = screen.getByRole('button', { name: '返回账号登录' });
    expect(returnButton).toBeDisabled();
    fireEvent.click(returnButton);
    expect(screen.getByLabelText('恢复码')).toBeInTheDocument();
    await act(async () => resolveRecovery({ data: {
      access_token: 'recovery-access-after-pending-placeholder', expires_in: 86400, username: 'alice',
    } }));
    expect(await screen.findByText('首页已加载')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith('recovery-access-after-pending-placeholder', 'alice');
  });

  it('does not establish a session if a recovery response arrives after unmount', async () => {
    let resolveRecovery!: (response: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolveRecovery = resolve; }) as never);
    const view = renderLogin();
    await openRecoveryMode();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('恢复码'), { target: { value: 'ABCD-EFGH-JK' } });
    fireEvent.click(screen.getByRole('button', { name: '使用恢复码登录' }));
    view.unmount();

    await act(async () => resolveRecovery({ data: {
      access_token: 'unmounted-recovery-access-placeholder', expires_in: 86400, username: 'alice',
    } }));
    expect(login).not.toHaveBeenCalled();
  });

  it('keeps recovery form labels and code content inside the narrow login card', async () => {
    renderLogin();
    await openRecoveryMode();
    const form = screen.getByRole('form', { name: '恢复码登录' });
    expect(form).toHaveClass('min-w-0');
    expect(screen.getByLabelText('恢复码')).toHaveClass('min-w-0', 'w-full');
    expect(screen.getByRole('button', { name: '使用恢复码登录' })).toHaveClass('w-full');
    expect(screen.getByLabelText('恢复码')).toHaveAttribute('autocomplete', 'one-time-code');
  });
});
