import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LocalizedReleaseSummary,
  UpdateReleaseCategory,
  UpdateStatusResponse,
} from '@filestation/shared';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';

interface UpdateCapabilityView {
  mode: 'managed' | 'docker' | 'unmanaged' | 'unsupported' | 'unavailable';
  supported: boolean;
  install_root: string | null;
  updater_version: string | null;
  platform: string;
  reason: string | null;
}

interface UpdateStatusView extends UpdateStatusResponse {
  checked_at?: string | null;
  decision?:
    | 'available'
    | 'same_version'
    | 'downgrade'
    | 'unsupported_platform'
    | 'node_required'
    | 'updater_required'
    | 'manual_bootstrap'
    | 'invalid_version'
    | 'unavailable';
  publisher_status?: 'unconfigured' | 'configured';
  capability?: UpdateCapabilityView;
  updater_version?: string | null;
  manifest_sha256?: string | null;
  artifact_sha256?: string | null;
  artifact_filename?: string | null;
  archive_size?: number | null;
  unpacked_size?: number | null;
  release_summaries?: Record<'zh-CN' | 'en', LocalizedReleaseSummary> | null;
  phase?: string;
  attempt_id?: string;
  fence?: number;
  target_version?: string;
  updated_at?: string;
}

interface PreparedUpdate {
  prepared_id: string;
  manifest_sha256: string;
  artifact_sha256: string;
  version: string;
  platform: string;
  arch: 'x64';
  staging_path: string;
  verified_size: number;
  unpacked_size: number;
  expires_at: number;
}

interface InstallAcceptance {
  attempt_id: string;
  prepared_id: string;
  fence: number;
  phase: 'PREPARED';
  accepted_at: string;
}

interface UpdateSectionProps {
  totpActive: boolean;
  pollIntervalMs?: number;
}

const CATEGORY_ORDER: readonly UpdateReleaseCategory[] = [
  'features',
  'fixes',
  'security',
  'upgrades',
  'breaking',
  'known_issues',
];

const ZH_CATEGORY_LABELS: Record<UpdateReleaseCategory, string> = {
  features: '新功能',
  fixes: '问题修复',
  security: '安全',
  upgrades: '升级',
  breaking: '破坏性变更',
  known_issues: '已知问题',
};

const EN_CATEGORY_LABELS: Record<UpdateReleaseCategory, string> = {
  features: 'Features',
  fixes: 'Fixes',
  security: 'Security',
  upgrades: 'Upgrades',
  breaking: 'Breaking changes',
  known_issues: 'Known issues',
};

const TERMINAL_PHASES = new Set(['COMMITTED', 'ROLLED_BACK', 'FAILED', 'ABORTED']);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatCheckedAt(value?: string | null): string {
  if (!value) return '上次检查：尚未完成';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '上次检查：时间未知';
  return `上次检查：${date.toLocaleString('zh-CN', { hour12: false })}`;
}

function categoryEntries(
  summary: LocalizedReleaseSummary | undefined,
  category: UpdateReleaseCategory,
) {
  const entries = summary?.[category];
  return Array.isArray(entries) ? entries.filter((entry) => entry.text.trim()) : [];
}

function hasAnySummary(summary: LocalizedReleaseSummary | undefined): boolean {
  return CATEGORY_ORDER.some((category) => categoryEntries(summary, category).length > 0);
}

function terminalMessage(phase: string): string {
  if (phase === 'COMMITTED') {
    return '更新完成';
  }
  if (phase === 'ROLLED_BACK') return '更新失败，已回滚到当前版本';
  if (phase === 'FAILED' || phase === 'ABORTED') return '更新失败';
  return '';
}

function ReleaseSummary({
  title,
  summary,
  labels,
}: {
  title: string;
  summary?: LocalizedReleaseSummary;
  labels: Record<UpdateReleaseCategory, string>;
}) {
  if (!hasAnySummary(summary)) return null;
  return (
    <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="space-y-3">
        {CATEGORY_ORDER.map((category) => {
          const entries = categoryEntries(summary, category);
          if (entries.length === 0) return null;
          return (
            <div key={category}>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {labels[category]}
              </h4>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                {entries.map((entry) => <li key={entry.id}>{entry.text}</li>)}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function UpdateSection({
  totpActive,
  pollIntervalMs,
}: UpdateSectionProps) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const [acceptedSession, setAcceptedSession] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedUpdate | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [attemptId, setAttemptId] = useState('');
  const [installPhase, setInstallPhase] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const checkInFlight = useRef(false);
  const prepareInFlight = useRef(false);
  const installInFlight = useRef(false);
  const attemptFence = useRef<number>();
  const acceptedTargetVersion = useRef<string>();

  const loadStatus = useCallback(async () => {
    const response = await api.getRaw<UpdateStatusView>('/updates/status');
    if (mounted.current && response) setStatus(response);
    return response;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadStatus()
      .catch((loadError) => {
        if (mounted.current) {
          setError(errorMessage(loadError, '加载更新状态失败，请重试。'));
        }
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [loadStatus]);

  useEffect(() => {
    if (!installing || !attemptId) return;
    if (accessToken !== acceptedSession) {
      setInstalling(false);
      setInstallMessage('登录会话已变化，请重新检查更新状态。');
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await api.getRaw<UpdateStatusView>(
          '/updates/status',
          undefined,
          controller.signal,
        );
        if (cancelled || controller.signal.aborted || !response) return;
        const latest = response;
        const observedFence = attemptFence.current;
        const targetVersion = acceptedTargetVersion.current;
        if (
          latest.attempt_id !== attemptId ||
          typeof latest.fence !== 'number' ||
          typeof observedFence !== 'number' ||
          typeof targetVersion !== 'string' ||
          latest.fence < observedFence ||
          latest.target_version !== targetVersion
        ) {
          setInstalling(false);
          setInstallPhase('SUPERSEDED');
          setInstallMessage('更新尝试已被替代或身份无法确认，请重新检查更新状态。');
          return;
        }
        attemptFence.current = latest.fence;
        setStatus(latest);
        setInstallPhase(latest.phase ?? '');
        if (latest.phase && TERMINAL_PHASES.has(latest.phase)) {
          setInstalling(false);
          setInstallMessage(terminalMessage(latest.phase));
          return;
        }
        setInstallMessage('更新安装已开始');
      } catch (pollError) {
        if (cancelled || controller.signal.aborted) return;
        setInstallMessage('暂时无法读取更新状态；服务恢复后会自动重试。');
        setError(errorMessage(pollError, '暂时无法读取更新状态。'));
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), pollIntervalMs ?? 1_500);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [attemptId, installing, pollIntervalMs, accessToken, acceptedSession]);

  const checkUpdate = async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    setError('');
    try {
      const response = await api.postRaw<UpdateStatusView>('/updates/check', { force: true });
      if (!response) throw new Error('服务器未返回更新检查结果。');
      setStatus(response);
      setPrepared(null);
      setInstallMessage('');
    } catch (checkError) {
      setError(errorMessage(checkError, '检查更新失败，请重试。'));
    } finally {
      checkInFlight.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  const prepareUpdate = async () => {
    if (
      prepareInFlight.current ||
      !status?.available_version ||
      !status.manifest_sha256 ||
      !status.artifact_sha256
    ) {
      return;
    }
    prepareInFlight.current = true;
    setPreparing(true);
    setError('');
    setInstallMessage('');
    try {
      const response = await api.postRaw<PreparedUpdate>('/updates/prepare', {
        version: status.available_version,
        manifest_sha256: status.manifest_sha256,
        artifact_sha256: status.artifact_sha256,
      });
      if (!response?.prepared_id) {
        throw new Error('服务器未返回已准备的更新凭据。');
      }
      setPrepared(response);
      setPassword('');
      setTotpCode('');
      setConfirmOpen(true);
    } catch (prepareError) {
      setError(errorMessage(prepareError, '下载或验证更新失败，请重试。'));
    } finally {
      prepareInFlight.current = false;
      if (mounted.current) setPreparing(false);
    }
  };

  const closeConfirmation = () => {
    if (confirming) return;
    setConfirmOpen(false);
    setPassword('');
    setTotpCode('');
    setError('');
  };

  const submitInstall = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      installInFlight.current ||
      !prepared ||
      !password ||
      (totpActive && !/^\d{6}$/.test(totpCode))
    ) {
      return;
    }
    installInFlight.current = true;
    setConfirming(true);
    setError('');
    const submittedPassword = password;
    const submittedTotp = totpCode;
    setPassword('');
    setTotpCode('');
    try {
      const response = await api.postRaw<InstallAcceptance>('/updates/install', {
        prepared_id: prepared.prepared_id,
        password: submittedPassword,
        ...(totpActive ? { totp_code: submittedTotp } : {}),
      });
      const accepted = response;
      if (
        !accepted?.attempt_id ||
        accepted.phase !== 'PREPARED' ||
        typeof accepted.fence !== 'number'
      ) {
        throw new Error('服务器未返回有效的更新尝试。');
      }
      setAttemptId(accepted.attempt_id);
      attemptFence.current = accepted.fence;
      acceptedTargetVersion.current = prepared.version;
      setAcceptedSession(accessToken);
      setInstallPhase(accepted.phase);
      setInstallMessage('更新安装已开始');
      setInstalling(true);
      setConfirmOpen(false);
      setPrepared(null);
    } catch (installError) {
      setError(errorMessage(installError, '确认安装失败，请重新输入凭据。'));
    } finally {
      installInFlight.current = false;
      if (mounted.current) setConfirming(false);
    }
  };

  const capability = status?.capability;
  const managed =
    capability?.mode === 'managed' &&
    capability.supported &&
    Boolean(capability.install_root) &&
    Boolean(capability.updater_version);
  const autoUpdateAvailable =
    managed &&
    status?.decision === 'available' &&
    Boolean(status.available_version) &&
    Boolean(status.manifest_sha256) &&
    Boolean(status.artifact_sha256);
  const latestVersion = status?.available_version ?? status?.current_version;
  const releaseSummaries = status?.release_summaries;
  const hasBreaking = Boolean(
    releaseSummaries && (
      categoryEntries(releaseSummaries['zh-CN'], 'breaking').length > 0
      || categoryEntries(releaseSummaries.en, 'breaking').length > 0
    )
  );

  return (
    <section
      className="mb-6 min-w-0 rounded-lg bg-white p-4 shadow md:p-6"
      aria-labelledby="update-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="update-heading" className="text-lg font-medium">软件更新</h2>
          <p className="mt-1 text-sm text-gray-600">
            检查已签名的稳定版本。下载、验证和安装状态均由服务器确认。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void checkUpdate()}
          disabled={checking || loading}
          className="self-start rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {checking ? '正在检查…' : '立即检查'}
        </button>
      </div>

      {loading ? (
        <p role="status" className="mt-4 text-sm text-gray-500">正在读取更新状态…</p>
      ) : status ? (
        <>
          <dl className="mt-5 grid grid-cols-1 gap-3 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">当前版本</dt>
              <dd className="font-mono font-medium text-gray-900">v{status.current_version}</dd>
            </div>
            <div>
              <dt className="text-gray-500">最新稳定版</dt>
              <dd className="font-mono font-medium text-gray-900">
                {latestVersion ? `v${latestVersion}` : '未知'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500">检查时间</dt>
              <dd className="text-gray-700">{formatCheckedAt(status.checked_at)}</dd>
            </div>
          </dl>

          {status.error_code && (
            <p role="alert" className="mt-4 break-words rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {status.message ?? status.error_code}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 break-words rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </p>
          )}

          {status.decision === 'same_version' && (
            <p role="status" className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              已是最新版本
            </p>
          )}

          {(status.decision === 'manual_bootstrap'
            || capability?.mode === 'unmanaged'
            || capability?.reason === 'UNMANAGED_INSTALL') && (
            <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <h3 className="font-semibold">需要手动 bootstrap</h3>
              <p className="mt-1">
                This installation requires a managed installation bootstrap before
                automatic updates can be enabled. Stop the old service, run the
                documented bootstrap workflow, then check again.
              </p>
            </div>
          )}

          {capability?.mode === 'docker' && (
            <div className="mt-4 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <h3 className="font-semibold">Docker 镜像升级</h3>
              <p className="mt-1">
                请先在宿主机 pull 新的 Docker image，再按部署文档替换容器；不要启用
                container 内自更新，也不要挂载 Docker socket。
              </p>
            </div>
          )}

          {!capability && !status.error_code && status.decision !== 'manual_bootstrap' && (
            <p className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
              此服务器未返回自动更新能力信息。
            </p>
          )}

          {(capability?.mode === 'unsupported' || status.decision === 'unsupported_platform') && (
            <div className="mt-4 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <h3 className="font-semibold">当前平台不支持自动更新</h3>
              <p className="mt-1">
                检测到的平台：{capability?.platform ?? 'unknown'}。自动更新仅支持
                Windows x64 与 Linux x64。
              </p>
            </div>
          )}

          {status.decision === 'updater_required' && (
            <p role="alert" className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              当前 updater 版本不兼容。请先按升级指南手动升级 updater，再重新检查。
            </p>
          )}
          {status.decision === 'node_required' && (
            <p role="alert" className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              当前 Node.js 运行时版本不满足发布要求，请先升级运行环境。
            </p>
          )}

          {capability && capability.mode !== 'docker' && capability.mode !== 'unsupported' && (
            <div className="mt-5 rounded-lg border border-gray-200 p-4 text-sm">
              <h3 className="font-medium text-gray-900">自动更新能力</h3>
              <p className="mt-1 text-gray-600">
                {managed
                  ? `Managed installation · ${capability.platform} · updater ${capability.updater_version}`
                  : `状态：${capability.mode}${capability.reason ? ` · ${capability.reason}` : ''}`}
              </p>
            </div>
          )}

          {releaseSummaries && (
            <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <ReleaseSummary
                title="中文发布说明"
                summary={releaseSummaries['zh-CN']}
                labels={ZH_CATEGORY_LABELS}
              />
              <ReleaseSummary
                title="English release notes"
                summary={releaseSummaries.en}
                labels={EN_CATEGORY_LABELS}
              />
            </div>
          )}

          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <h3 className="font-semibold">风险与迁移注意事项</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>安装期间普通操作会暂停，请先保存正在编辑的内容。</li>
              <li>更新校验失败会中止；已验证阶段失败会尝试回滚到本机已验证版本。</li>
              {hasBreaking && <li>发布说明包含破坏性变更，请先阅读升级指南。</li>}
              {status.decision === 'manual_bootstrap' && (
                <li>升级前必须完成手动 bootstrap。</li>
              )}
            </ul>
          </div>

          {(installMessage || installing) && (
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <p role="status" className="font-medium">
                {installMessage || '更新安装已开始'}
              </p>
              {attemptId && (
                <p className="mt-1 break-all font-mono text-xs">
                  attempt {attemptId}
                  {installPhase ? ` · ${installPhase}` : ''}
                </p>
              )}
            </div>
          )}

          {autoUpdateAvailable && !installing && (
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void prepareUpdate()}
                disabled={preparing}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {preparing ? '正在下载并验证…' : '下载并验证更新'}
              </button>
              {prepared && !preparing && (
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setPassword('');
                    setTotpCode('');
                    setConfirmOpen(true);
                  }}
                  className="rounded-md border border-blue-300 px-4 py-2 text-sm text-blue-800 hover:bg-blue-50"
                >
                  安装已准备好的更新
                </button>
              )}
            </div>
          )}

          {preparing && (
            <div
              role="progressbar"
              aria-label="更新准备进度"
              aria-valuetext="正在下载并验证更新"
              className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100"
            >
              <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-600" />
            </div>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-red-700">无法读取更新状态。</p>
      )}

      {confirmOpen && prepared && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70 p-4" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-confirm-title"
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
          >
            <h3 id="update-confirm-title" className="text-lg font-semibold text-gray-900">
              确认安装更新
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              即将安装 v{prepared.version}。请输入当前管理员凭据，确认后服务将短暂进入维护状态。
            </p>
            <form className="mt-4 space-y-4" onSubmit={submitInstall}>
              <div>
                <label htmlFor="update-current-password" className="block text-sm font-medium text-gray-700">
                  当前密码
                </label>
                <input
                  id="update-current-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={confirming}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                />
              </div>
              {totpActive && (
                <div>
                  <label htmlFor="update-current-totp" className="block text-sm font-medium text-gray-700">
                    当前 6 位 TOTP 验证码
                  </label>
                  <input
                    id="update-current-totp"
                    type="text"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={confirming}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                  />
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="submit"
                  disabled={confirming || !password || (totpActive && !/^\d{6}$/.test(totpCode))}
                  className="rounded-md bg-green-700 px-4 py-2 text-sm text-white hover:bg-green-800 disabled:opacity-50"
                >
                  {confirming ? '正在确认…' : '确认安装'}
                </button>
                <button
                  type="button"
                  onClick={closeConfirmation}
                  disabled={confirming}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
