import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import AppLayout from '../components/AppLayout';
import ApiTokensSection from './settings/ApiTokensSection';
import AgentSection from './settings/AgentSection';
import TotpSection from './settings/TotpSection';

interface Settings {
  site: { name: string; icon: string | null; theme_color: string };
  security: { totp_required: boolean; totp_active: boolean; max_login_attempts: number; lockout_minutes: number };
  transfer: { default_chunk_size: number; global_upload_limit_bps: number | null; global_download_limit_bps: number | null };
  storage: { path: string; max_size_gb: number; cleanup_grace_hours: number; default_expire_hours: number };
  agent: { mcp_enabled: boolean; mcp_max_upload_mb: number };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const saveInFlight = useRef(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await api.get<Settings>('/settings');
      setSettings(response.data!);
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const refreshAgentSettings = async () => {
    const response = await api.get<Settings>('/settings');
    setSettings((current) => current
      ? { ...current, agent: response.data!.agent }
      : response.data!);
  };

  const refreshTotpStatus = async () => {
    const response = await api.get<Settings>('/settings');
    const latest = response.data!;
    setSettings((current) => current
      ? {
        ...current,
        security: {
          ...current.security,
          totp_active: latest.security.totp_active,
          totp_required: latest.security.totp_required,
        },
      }
      : latest);
  };

  const handleSave = async () => {
    if (!settings || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError('');
    setSaveNotice('');
    try {
      // v1.6：PUT 前剔除 storage.path（只读字段，后端 DTO 拒绝带 path 的请求）
      const { path: _ignored, ...storagePayload } = settings.storage;
      const { totp_active: _derived, ...securityPayload } = settings.security;
      await api.put('/settings', {
        site: settings.site,
        security: securityPayload,
        transfer: settings.transfer,
        storage: storagePayload,
      });
      setSaveNotice('设置已保存。');
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : '保存失败，请重试。');
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex flex-1 items-center justify-center">加载中...</div>
      </AppLayout>
    );
  }

  if (!settings) {
    return (
      <AppLayout>
        <div className="flex flex-1 items-center justify-center">加载失败</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-bold mb-8">设置</h1>

          <div className="bg-white shadow rounded-lg p-6 mb-6">
            <h2 className="text-lg font-medium mb-4">站点设置</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">站点名称</label>
                <input
                  type="text"
                  value={settings.site.name}
                  onChange={(e) => setSettings({ ...settings, site: { ...settings.site, name: e.target.value } })}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
          </div>

          <div className="bg-white shadow rounded-lg p-6 mb-6">
            <h2 className="text-lg font-medium mb-4">安全设置</h2>
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="totp-required" className="flex items-start gap-3 text-sm text-gray-700 min-h-8">
                  <input
                    id="totp-required"
                    type="checkbox"
                    checked={settings.security.totp_required}
                    onChange={(event) => setSettings({
                      ...settings,
                      security: { ...settings.security, totp_required: event.target.checked },
                    })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>要求登录时使用 TOTP</span>
                </label>
                <p className="pl-7 text-xs text-gray-500">
                  绑定状态：{settings.security.totp_active ? '已启用' : '未启用'}。启用强制验证前，请先绑定验证器。
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">最大登录失败次数</label>
                <input
                  type="number"
                  value={settings.security.max_login_attempts}
                  onChange={(e) => setSettings({
                    ...settings,
                    security: { ...settings.security, max_login_attempts: parseInt(e.target.value) }
                  })}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">锁定时长（分钟）</label>
                <input
                  type="number"
                  value={settings.security.lockout_minutes}
                  onChange={(e) => setSettings({
                    ...settings,
                    security: { ...settings.security, lockout_minutes: parseInt(e.target.value) }
                  })}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
          </div>

          <TotpSection totpActive={settings.security.totp_active} onChanged={refreshTotpStatus} />
          <ApiTokensSection />
          <AgentSection agent={settings.agent} onSaved={refreshAgentSettings} />

          <div className="bg-white shadow rounded-lg p-6 mb-6">
            <h2 className="text-lg font-medium mb-4">存储设置</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">存储路径（只读，由环境变量控制）</label>
                <input
                  type="text"
                  value={settings.storage.path}
                  readOnly
                  disabled
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100 text-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">默认过期时间（小时，0 = 永久）</label>
                <input
                  type="number"
                  value={settings.storage.default_expire_hours}
                  onChange={(e) => setSettings({
                    ...settings,
                    storage: { ...settings.storage, default_expire_hours: parseInt(e.target.value) }
                  })}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
          </div>

          {saveError && <p role="alert" className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 break-words">{saveError}</p>}
          {saveNotice && <p role="status" className="mb-3 text-sm text-green-700">{saveNotice}</p>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </AppLayout>
  );
}
