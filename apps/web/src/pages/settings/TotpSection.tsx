import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

interface TotpSetupData {
  secret: string;
  qr_code_data_url: string;
}

interface TotpSectionProps {
  totpActive: boolean;
  onChanged: () => void | Promise<void>;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function TotpSection({ totpActive, onChanged }: TotpSectionProps) {
  const [setup, setSetup] = useState<TotpSetupData | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [disableLoading, setDisableLoading] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [disableError, setDisableError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [notice, setNotice] = useState('');
  const [optimisticActive, setOptimisticActive] = useState<boolean | null>(null);
  const active = optimisticActive ?? totpActive;
  const latestTotpActive = useRef(totpActive);
  latestTotpActive.current = totpActive;
  const setupGeneration = useRef(0);
  const confirmGeneration = useRef(0);
  const disableGeneration = useRef(0);
  const setupInFlight = useRef(false);
  const mounted = useRef(false);
  const confirmInFlight = useRef(false);
  const disableInFlight = useRef(false);

  useEffect(() => {
    setOptimisticActive(null);
    if (totpActive) {
      setupGeneration.current += 1;
      setSetup(null);
      setCode('');
      setDisableOpen(false);
    }
  }, [totpActive]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setupGeneration.current += 1;
      confirmGeneration.current += 1;
      disableGeneration.current += 1;
    };
  }, []);

  const startSetup = async () => {
    if (active || setupInFlight.current) return;
    const generation = ++setupGeneration.current;
    setupInFlight.current = true;
    setSetupLoading(true);
    setSetupError('');
    setConfirmError('');
    setRefreshError('');
    setNotice('');

    try {
      const response = await api.post<TotpSetupData>('/auth/totp/setup', {});
      if (generation !== setupGeneration.current || latestTotpActive.current) return;
      const data = response.data;
      if (!data?.secret || !data.qr_code_data_url) {
        throw new Error('服务器未返回完整的 TOTP 初始化信息。');
      }
      setSetup({ secret: data.secret, qr_code_data_url: data.qr_code_data_url });
      setCode('');
    } catch (error) {
      if (generation === setupGeneration.current) {
        setSetupError(getErrorMessage(error, '初始化失败，请重试。'));
      }
    } finally {
      if (generation === setupGeneration.current) {
        setupInFlight.current = false;
      }
      if (mounted.current && generation === setupGeneration.current) {
        setSetupLoading(false);
      }
    }
  };

  const cancelSetup = () => {
    setupGeneration.current += 1;
    setupInFlight.current = false;
    setSetupLoading(false);
    setSetup(null);
    setCode('');
    setSetupError('');
    setConfirmError('');
    setRefreshError('');
    setNotice('');
  };

  const confirmSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!setup || confirmInFlight.current || !/^\d{6}$/.test(code)) return;
    const generation = ++confirmGeneration.current;
    confirmInFlight.current = true;
    setConfirmLoading(true);
    setConfirmError('');
    setRefreshError('');
    setNotice('');

    try {
      await api.post('/auth/totp/confirm', { code });
      if (generation !== confirmGeneration.current) return;
      setSetup(null);
      setCode('');
      setOptimisticActive(true);
      setNotice('TOTP 已启用。');
      try {
        await onChanged();
      } catch {
        setRefreshError('TOTP 已启用，但状态刷新失败；请重新载入设置确认状态。');
      }
    } catch (error) {
      if (generation === confirmGeneration.current) {
        setConfirmError(getErrorMessage(error, '验证码错误，请重试。'));
      }
    } finally {
      if (generation === confirmGeneration.current) {
        confirmInFlight.current = false;
        setConfirmLoading(false);
      }
    }
  };

  const openDisable = () => {
    setDisableOpen(true);
    setPassword('');
    setCode('');
    setDisableError('');
    setRefreshError('');
    setNotice('');
  };

  const cancelDisable = () => {
    setDisableOpen(false);
    setPassword('');
    setCode('');
    setDisableError('');
    setRefreshError('');
    setNotice('');
  };

  const disableTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active || disableInFlight.current || !password || !/^\d{6}$/.test(code)) return;
    const generation = ++disableGeneration.current;
    disableInFlight.current = true;
    setDisableLoading(true);
    setDisableError('');
    setRefreshError('');
    setNotice('');

    try {
      await api.post('/auth/totp/disable', { password, code });
      if (generation !== disableGeneration.current) return;
      setDisableOpen(false);
      setPassword('');
      setCode('');
      setOptimisticActive(false);
      setNotice('TOTP 已停用。');
      try {
        await onChanged();
      } catch {
        setRefreshError('TOTP 已停用，但状态刷新失败；请重新载入设置确认状态。');
      }
    } catch (error) {
      if (generation === disableGeneration.current) {
        setDisableError(getErrorMessage(error, '停用失败，请重试。'));
      }
    } finally {
      if (generation === disableGeneration.current) {
        disableInFlight.current = false;
        setDisableLoading(false);
      }
    }
  };

  return (
    <section className="bg-white shadow rounded-lg p-4 md:p-6 mb-6" aria-labelledby="totp-heading">
      <h2 id="totp-heading" className="text-lg font-medium mb-1">两步验证（TOTP）</h2>
      <p className="text-sm text-gray-600 mb-4">
        使用验证器 App 扫描二维码，或手动输入密钥。启用后，下次登录需要验证码。
      </p>

      {setupError && <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3 break-words">{setupError}</p>}
      {confirmError && <p id="totp-confirm-error" role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3 break-words">{confirmError}</p>}
      {disableError && <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3 break-words">{disableError}</p>}
      {refreshError && <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3 break-words">{refreshError}</p>}
      {notice && <p role="status" className="text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}

      {!active && !setup && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void startSetup()}
            disabled={setupLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {setupLoading ? '正在准备二维码…' : '启用 TOTP'}
          </button>
          {setupLoading && (
            <button
              type="button"
              onClick={cancelSetup}
              className="px-4 py-2 border rounded-md text-sm"
            >
              取消初始化
            </button>
          )}
        </div>
      )}

      {setup && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4 min-w-0">
            <img
              src={setup.qr_code_data_url}
              alt="TOTP 设置二维码"
              className="w-48 h-48 max-w-full border rounded bg-white"
            />
            <div className="min-w-0 text-sm">
              <p className="text-gray-600 mb-1">无法扫码？请在验证器中手动输入此密钥：</p>
              <code className="block max-w-full font-mono text-xs bg-gray-50 border rounded p-3 break-all select-all">{setup.secret}</code>
            </div>
          </div>

          <form className="space-y-3" onSubmit={confirmSetup}>
            <div className="max-w-sm">
              <label htmlFor="totp-confirm-code" className="block text-sm font-medium text-gray-700">确认验证码</label>
              <input
                id="totp-confirm-code"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={confirmLoading}
                aria-invalid={Boolean(confirmError)}
                aria-describedby={confirmError ? 'totp-confirm-error' : undefined}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="submit"
                disabled={confirmLoading || !/^\d{6}$/.test(code)}
                className="px-4 py-2 bg-green-700 text-white rounded-md text-sm hover:bg-green-800 disabled:opacity-50"
              >
                {confirmLoading ? '确认中…' : '确认启用'}
              </button>
              <button
                type="button"
                onClick={cancelSetup}
                disabled={confirmLoading}
                className="px-4 py-2 border rounded-md text-sm disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {active && !disableOpen && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-green-800">
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-green-600" />
            已启用
          </span>
          <button
            type="button"
            onClick={openDisable}
            className="self-start sm:self-auto px-3 py-2 text-sm text-red-700 border border-red-200 rounded-md hover:bg-red-50"
          >
            停用 TOTP
          </button>
        </div>
      )}

      {active && disableOpen && (
        <form className="space-y-3 max-w-sm" onSubmit={disableTotp}>
          <div>
            <label htmlFor="totp-disable-password" className="block text-sm font-medium text-gray-700">当前密码</label>
            <input
              id="totp-disable-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={disableLoading}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm disabled:bg-gray-100"
            />
          </div>
          <div>
            <label htmlFor="totp-disable-code" className="block text-sm font-medium text-gray-700">当前验证码</label>
            <input
              id="totp-disable-code"
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={disableLoading}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm disabled:bg-gray-100"
            />
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="submit"
              disabled={disableLoading || !password || !/^\d{6}$/.test(code)}
              className="px-4 py-2 bg-red-700 text-white rounded-md text-sm hover:bg-red-800 disabled:opacity-50"
            >
              {disableLoading ? '停用中…' : '确认停用'}
            </button>
            <button
              type="button"
              onClick={cancelDisable}
              disabled={disableLoading}
              className="px-4 py-2 border rounded-md text-sm disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
