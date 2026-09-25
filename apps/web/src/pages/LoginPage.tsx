import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LoginResponseData } from '@filestation/shared';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

interface TotpLoginResponse {
  access_token: string;
  expires_in: number;
  username: string;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [totpError, setTotpError] = useState('');
  const [loading, setLoading] = useState(false);
  const [secondFactor, setSecondFactor] = useState<{ challenge: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const requestGeneration = useRef(0);
  const requestInFlight = useRef(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);

  const handlePasswordSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (requestInFlight.current) return;

    const generation = ++requestGeneration.current;
    requestInFlight.current = true;
    setPasswordError('');
    setTotpError('');
    setLoading(true);

    try {
      const response = await api.post<LoginResponseData>('/auth/login', { username, password });
      if (generation !== requestGeneration.current) return;
      const data = response.data;
      if (!data) throw new Error('登录失败，请重试。');

      if ('requires_second_factor' in data) {
        if (!data.available_methods.includes('totp')) {
          throw new Error('当前账户暂不支持此二次验证方式。');
        }
        setSecondFactor({ challenge: data.login_challenge });
        setTotpCode('');
        setPassword('');
        return;
      }

      login(data.access_token, username);
      navigate('/');
    } catch (error) {
      if (generation === requestGeneration.current) {
        setPasswordError(getErrorMessage(error, '登录失败，请重试。'));
      }
    } finally {
      if (generation === requestGeneration.current) {
        requestInFlight.current = false;
        setLoading(false);
      }
    }
  };

  const handleTotpSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!secondFactor || requestInFlight.current || !/^\d{6}$/.test(totpCode)) return;

    const generation = ++requestGeneration.current;
    const challenge = secondFactor.challenge;
    const code = totpCode;
    requestInFlight.current = true;
    setTotpError('');
    setLoading(true);

    try {
      const response = await api.post<TotpLoginResponse>('/auth/login/totp', {
        login_challenge: challenge,
        totp_code: code,
      });
      if (generation !== requestGeneration.current) return;
      const data = response.data;
      if (!data) throw new Error('验证失败，请重新登录。');
      login(data.access_token, data.username);
      navigate('/');
    } catch (error) {
      if (generation === requestGeneration.current) {
        setTotpError(getErrorMessage(error, '验证失败，请重新登录。'));
        // Task 8 consumes every challenge on use, including an incorrect code or an uncertain network result.
        setSecondFactor(null);
        setTotpCode('');
        setPassword('');
      }
    } finally {
      if (generation === requestGeneration.current) {
        requestInFlight.current = false;
        setLoading(false);
      }
    }
  };

  const returnToPasswordStep = () => {
    requestGeneration.current += 1;
    requestInFlight.current = false;
    setLoading(false);
    setSecondFactor(null);
    setTotpCode('');
    setPassword('');
    setPasswordError('');
    setTotpError('');
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="max-w-md w-full space-y-8 p-6 sm:p-8 bg-white rounded-lg shadow">
        <div>
          <h1 className="text-center text-3xl font-bold">FileStation</h1>
          <p className="mt-2 text-center text-sm text-gray-600">
            {secondFactor ? '输入验证器中的 6 位验证码以继续登录' : '登录到您的账户'}
          </p>
        </div>

        {secondFactor ? (
          <form className="space-y-6" onSubmit={handleTotpSubmit} aria-labelledby="totp-login-heading">
            <h2 id="totp-login-heading" className="text-center text-lg font-medium">两步验证</h2>
            {totpError && <p id="totp-login-error" role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded break-words">{totpError}</p>}
            <div>
              <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700">验证器验证码</label>
              <input
                id="totp-code"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                pattern="[0-9]{6}"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={loading}
                aria-describedby={totpError ? 'totp-login-error' : undefined}
                aria-invalid={Boolean(totpError)}
                className="mt-1 block w-full px-3 py-3 text-center tracking-[0.35em] text-xl border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !/^\d{6}$/.test(totpCode)}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? '验证中...' : '验证并登录'}
            </button>
            <button
              type="button"
              onClick={returnToPasswordStep}
              className="w-full py-2 text-sm text-blue-700 underline underline-offset-2"
            >
              返回账号登录
            </button>
          </form>
        ) : (
          <form className="space-y-6" onSubmit={handlePasswordSubmit}>
            {passwordError && <p id="password-login-error" role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded break-words">{passwordError}</p>}
            {totpError && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded break-words">{totpError}</p>}

            <div className="space-y-4">
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700">用户名</label>
                <input
                  id="username"
                  type="text"
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={loading}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">密码</label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={loading}
                  aria-describedby={passwordError ? 'password-login-error' : undefined}
                  aria-invalid={Boolean(passwordError)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
