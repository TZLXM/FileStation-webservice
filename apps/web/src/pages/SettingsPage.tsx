import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import AppLayout from '../components/AppLayout';

interface Settings {
  site: { name: string; icon: string | null; theme_color: string };
  security: { totp_required: boolean; max_login_attempts: number; lockout_minutes: number };
  transfer: { default_chunk_size: number; global_upload_limit_bps: number | null; global_download_limit_bps: number | null };
  storage: { path: string; max_size_gb: number; cleanup_grace_hours: number; default_expire_hours: number };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      // v1.6：PUT 前剔除 storage.path（只读字段，后端 DTO 拒绝带 path 的请求）
      const { path: _ignored, ...storagePayload } = settings.storage;
      await api.put('/settings', {
        site: settings.site,
        security: settings.security,
        transfer: settings.transfer,
        storage: storagePayload,
      });
      alert('设置已保存');
    } catch (err) {
      alert('保存失败');
    } finally {
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
              {/* Phase 1 不渲染 totp_required（后端未实现，DTO 层拒绝写 true） */}
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
