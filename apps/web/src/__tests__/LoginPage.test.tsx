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

  it('ignores a late verification response after returning to password login', async () => {
    let resolveVerification!: (value: unknown) => void;
    mockedApi.post
      .mockResolvedValueOnce({ data: { requires_second_factor: true, login_challenge: challengeOne, available_methods: ['totp'] } } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveVerification = resolve; }) as never);
    renderLogin();

    await submitPassword();
    fireEvent.change(await screen.findByLabelText('验证器验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
    fireEvent.click(screen.getByRole('button', { name: '返回账号登录' }));

    await act(async () => {
      resolveVerification({ data: { access_token: 'stale-access-placeholder', expires_in: 900, username: 'alice' } });
    });
    await waitFor(() => expect(screen.getByLabelText('密码')).toBeInTheDocument());
    expect(screen.queryByText('首页已加载')).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
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
});
