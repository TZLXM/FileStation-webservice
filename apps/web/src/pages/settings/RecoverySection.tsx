import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

interface RecoverySectionProps {
  totpActive: boolean;
}

interface RecoveryGenerateResponse {
  codes: string[];
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function RecoverySection({ totpActive }: RecoverySectionProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const requestInFlight = useRef(false);
  const codesGeneration = useRef(0);
  const copyInFlight = useRef(false);
  const downloadInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      codesGeneration.current += 1;
      requestInFlight.current = false;
      copyInFlight.current = false;
      downloadInFlight.current = false;
    };
  }, []);

  useEffect(() => {
    if (!totpActive) setTotpCode('');
  }, [totpActive]);

  useEffect(() => {
    if (!generating) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [generating]);

  const openForm = () => {
    setPassword('');
    setTotpCode('');
    setError('');
    setNotice('');
    setFormOpen(true);
  };

  const cancelForm = () => {
    if (requestInFlight.current) return;
    requestGeneration.current += 1;
    requestInFlight.current = false;
    codesGeneration.current += 1;
    copyInFlight.current = false;
    downloadInFlight.current = false;
    setGenerating(false);
    setCopying(false);
    setDownloading(false);
    setFormOpen(false);
    setPassword('');
    setTotpCode('');
    setCodes(null);
    setError('');
    setNotice('');
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (requestInFlight.current || !password || (totpActive && !/^\d{6}$/.test(totpCode))) return;

    const generation = ++requestGeneration.current;
    const submittedPassword = password;
    const submittedTotpCode = totpCode;
    requestInFlight.current = true;
    setGenerating(true);
    setError('');
    setNotice('');
    setPassword('');
    setTotpCode('');

    try {
      const response = await api.post<RecoveryGenerateResponse>('/auth/recovery/generate', {
        password: submittedPassword,
        ...(totpActive ? { totp_code: submittedTotpCode } : {}),
      });
      if (!mounted.current || generation !== requestGeneration.current) return;

      const generatedCodes = response.data?.codes;
      if (!Array.isArray(generatedCodes) || generatedCodes.length !== 10
        || generatedCodes.some((code) => typeof code !== 'string' || code.length === 0)) {
        throw new Error('服务返回的恢复码不完整，请重试生成。');
      }

      codesGeneration.current += 1;
      setCodes(generatedCodes);
      setFormOpen(false);
      setNotice('恢复码只会展示一次，请立即保存；关闭后无法再次查看。');
    } catch (requestError) {
      if (mounted.current && generation === requestGeneration.current) {
        setError(getErrorMessage(requestError, '生成恢复码失败，请重试。'));
      }
    } finally {
      if (mounted.current && generation === requestGeneration.current) {
        requestInFlight.current = false;
        setGenerating(false);
      }
    }
  };

  const copyCodes = async () => {
    if (!codes || copyInFlight.current) return;
    const generation = codesGeneration.current;
    copyInFlight.current = true;
    setCopying(true);
    setError('');
    setNotice('');

    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await clipboard.writeText(codes.join('\n'));
      if (!mounted.current || generation !== codesGeneration.current) return;
      setNotice('全部恢复码已复制到剪贴板。');
    } catch {
      if (mounted.current && generation === codesGeneration.current) {
        setError('复制失败，请检查浏览器剪贴板权限后重试。');
      }
    } finally {
      if (mounted.current && generation === codesGeneration.current) {
        copyInFlight.current = false;
        setCopying(false);
      }
    }
  };

  const downloadCodes = () => {
    if (!codes || downloadInFlight.current) return;
    const generation = codesGeneration.current;
    downloadInFlight.current = true;
    setDownloading(true);
    setError('');
    setNotice('');

    let objectUrl: string | null = null;
    let link: HTMLAnchorElement | null = null;
    let downloadStarted = false;
    try {
      const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'filestation-recovery-codes.txt';
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      downloadStarted = true;
      if (mounted.current && generation === codesGeneration.current) {
        setNotice('恢复码文件已开始下载。');
      }
    } catch {
      if (mounted.current && generation === codesGeneration.current) {
        setError('下载失败，浏览器无法生成恢复码文件，请重试。');
      }
    } finally {
      try {
        link?.remove();
      } catch {
        // The temporary object URL is still revoked below if link cleanup fails.
      }
      if (objectUrl) {
        const urlToRevoke = objectUrl;
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(urlToRevoke);
          } catch {
            if (downloadStarted && mounted.current && generation === codesGeneration.current) {
              setNotice('');
              setError('恢复码文件已开始下载，但浏览器未能释放临时下载链接。');
            }
          }
        }, 0);
      }
      if (mounted.current && generation === codesGeneration.current) {
        downloadInFlight.current = false;
        setDownloading(false);
      }
    }
  };

  const dismissCodes = () => {
    codesGeneration.current += 1;
    copyInFlight.current = false;
    downloadInFlight.current = false;
    setCopying(false);
    setDownloading(false);
    setCodes(null);
    setError('');
    setNotice('');
  };

  const validTotp = /^\d{6}$/.test(totpCode);

  return (
    <section className="bg-white shadow rounded-lg p-4 md:p-6 mb-6 min-w-0" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading" className="text-lg font-medium mb-1">恢复码</h2>
      <p className="text-sm text-gray-600 mb-4">
        验证器无法使用时，可用恢复码登录。每组 10 个、每个只能使用一次，生成后 24 小时内有效；使用后会撤销所有现有登录会话。
      </p>
      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-4 break-words">
        若生成请求期间连接中断，本页无法确认服务器是否已替换旧恢复码；结果不确定时请先不要依赖恢复码，并确保仍有其他可用认证途径。
      </p>

      {generating && (
        <p role="status" className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded p-3 mb-3">
          恢复码正在生成，请保持此页面打开并等待结果；完成前不能取消或再次提交。
        </p>
      )}

      {error && <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3 break-words">{error}</p>}
      {notice && <p role="status" className="text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3 break-words">{notice}</p>}

      {!formOpen && !codes && (
        <button
          type="button"
          onClick={openForm}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          生成新的一组
        </button>
      )}

      {formOpen && (
        <form className="space-y-4 min-w-0" onSubmit={generate} aria-labelledby="recovery-generate-heading">
          <h3 id="recovery-generate-heading" className="text-sm font-medium text-gray-800">确认身份以生成恢复码</h3>
          <div>
            <label htmlFor="recovery-current-password" className="block text-sm font-medium text-gray-700">当前密码</label>
            <input
              id="recovery-current-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={generating}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'recovery-generate-error' : undefined}
              className="mt-1 block w-full min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
          </div>
          {totpActive && (
            <div>
              <label htmlFor="recovery-current-totp" className="block text-sm font-medium text-gray-700">当前 6 位 TOTP 验证码</label>
              <input
                id="recovery-current-totp"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={generating}
                aria-invalid={Boolean(error)}
                className="mt-1 block w-full min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>
          )}
          {error && <p id="recovery-generate-error" className="sr-only">{error}</p>}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="submit"
              disabled={generating || !password || (totpActive && !validTotp)}
              className="px-4 py-2 bg-green-700 text-white rounded-md text-sm hover:bg-green-800 disabled:opacity-50"
            >
              {generating ? '正在生成…' : '确认生成'}
            </button>
            <button
              type="button"
              onClick={cancelForm}
              disabled={generating}
              className="px-4 py-2 border rounded-md text-sm"
            >
              取消
            </button>
          </div>
          <p className="text-xs text-gray-500 break-words">确认生成后，原有未使用恢复码会立即失效。</p>
        </form>
      )}

      {codes && (
        <div className="space-y-3 min-w-0">
          <ul role="list" aria-label="一次性恢复码" className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
            {codes.map((code, index) => (
              <li key={`${index}-${code}`} className="min-w-0">
                <code className="block min-w-0 px-2 py-2 bg-gray-50 border rounded font-mono text-sm break-all select-all">{code}</code>
              </li>
            ))}
          </ul>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => void copyCodes()}
              disabled={copying}
              className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {copying ? '正在复制…' : '复制全部'}
            </button>
            <button
              type="button"
              onClick={downloadCodes}
              disabled={downloading}
              className="px-3 py-2 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              {downloading ? '正在准备下载…' : '下载恢复码'}
            </button>
            <button
              type="button"
              onClick={dismissCodes}
              className="px-3 py-2 border rounded text-sm hover:bg-gray-50"
            >
              我已安全保存，关闭
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
