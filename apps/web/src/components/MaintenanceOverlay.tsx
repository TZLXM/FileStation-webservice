import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import {
  MaintenanceStatusView,
  maintenanceStore,
} from '../lib/maintenance';
import { useAuthStore } from '../stores/authStore';

interface MaintenanceOverlayProps {
  pollIntervalMs?: number;
}

const PHASE_LABELS: Record<string, string> = {
  PREPARED: '已确认，等待安全切换',
  MAINTENANCE: '正在冻结写入并准备更新',
  SNAPSHOT_READY: '数据库快照已完成',
  HANDOFF_READY: '正在切换到更新进程',
  OLD_STOPPED: '旧进程已安全停止',
  SWITCH_INTENT: '正在切换发布版本',
  CURRENT_SWITCHED: '发布版本已切换，正在迁移',
  MIGRATING: '正在迁移数据库',
  MIGRATED_VERIFIED: '迁移验证完成',
  READY_TO_COMMIT: '正在执行最终提交',
  ROLLBACK_INTENT: '更新失败，正在回滚',
};

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export default function MaintenanceOverlay({
  pollIntervalMs,
}: MaintenanceOverlayProps) {
  const maintenance = maintenanceStore();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [refresh, setRefresh] = useState(0);
  const [pollInFlight, setPollInFlight] = useState(false);

  useEffect(() => {
    if (!maintenance.active) return;
    const controller = new AbortController();
    const { signal } = controller;
    let inFlight = false;
    const readinessOnly = !accessToken || maintenance.authError;
    const poll = async () => {
      if (inFlight || signal.aborted) return;
      inFlight = true;
      setPollInFlight(true);
      try {
        const response = await api.get<MaintenanceStatusView>(
          readinessOnly ? '/auth/status' : '/updates/status',
          undefined,
          signal,
        );
        if (signal.aborted) return;
        if (readinessOnly) {
          // Public auth readiness remains behind the server maintenance barrier.
          // Success proves admission resumed, without exposing admin journal data.
          maintenanceStore.getState().reset();
          return;
        }
        const status = response.data;
        if (!status) {
          maintenanceStore.getState().setPollError(
            '服务器暂未返回更新状态；服务重启后会自动重试。',
          );
          return;
        }
        maintenanceStore.getState().applyStatus(status);
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        if (isAuthenticationFailure(error)) {
          maintenanceStore.getState().setPollError(
            '登录已过期。服务恢复后可重新登录。',
            true,
          );
          return;
        }
        maintenanceStore.getState().setPollError(
          '暂时无法连接状态接口；网络恢复后会自动重试。',
        );
      } finally {
        inFlight = false;
        if (!signal.aborted) setPollInFlight(false);
      }
    };
    void poll();
    const delay = pollIntervalMs ?? Math.max(1, maintenance.retryAfterSeconds) * 1_000;
    const timer = window.setInterval(() => {
      void poll();
    }, delay);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    maintenance.active,
    maintenance.authError,
    maintenance.retryAfterSeconds,
    accessToken,
    refresh,
    pollIntervalMs,
  ]);

  if (!maintenance.active) return null;

  const phase = maintenance.phase ?? 'MAINTENANCE';
  const retrySeconds = Math.max(1, maintenance.retryAfterSeconds);
  const reloadPage = () => window.location.reload();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/75 p-4"
      role="presentation"
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="maintenance-title"
        aria-describedby="maintenance-description"
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <span
            className="mt-1 h-3 w-3 shrink-0 animate-pulse rounded-full bg-amber-500"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 id="maintenance-title" className="text-xl font-semibold text-gray-900">
              系统维护中
            </h2>
            <p id="maintenance-description" className="mt-2 text-sm text-gray-600">
              更新期间普通操作会暂停。页面会保留，并查询更新状态或服务恢复状态。
            </p>
          </div>
        </div>

        <dl className="mb-4 grid grid-cols-1 gap-2 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">当前阶段</dt>
            <dd className="font-medium text-gray-900">{PHASE_LABELS[phase] ?? phase}</dd>
          </div>
          <div>
            <dt className="text-gray-500">目标版本</dt>
            <dd className="font-medium text-gray-900">
              {maintenance.targetVersion ? `v${maintenance.targetVersion}` : '正在读取…'}
            </dd>
          </div>
          {maintenance.attemptId && (
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-gray-500">更新尝试</dt>
              <dd className="font-mono text-xs text-gray-800 break-all">
                {maintenance.attemptId}
              </dd>
            </div>
          )}
        </dl>

        <p className="mb-4 text-sm text-gray-600" aria-live="polite">
          {`后台每 ${retrySeconds} 秒刷新一次状态；更新进程重启期间短暂失败属于正常现象。`}
        </p>

        {maintenance.pollError && (
          <p
            role="alert"
            className={`mb-4 break-words rounded border p-3 text-sm ${
              maintenance.authError
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {maintenance.pollError}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              setRefresh((value) => value + 1);
            }}
            disabled={pollInFlight}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pollInFlight ? '正在查询…' : '立即刷新状态'}
          </button>
          <button
            type="button"
            onClick={reloadPage}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            重新加载页面
          </button>
        </div>
      </section>
    </div>
  );
}
