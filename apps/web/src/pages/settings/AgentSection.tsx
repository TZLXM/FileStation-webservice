import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface AgentSettings {
  mcp_enabled: boolean;
  mcp_max_upload_mb: number;
}

interface AgentSectionProps {
  agent: AgentSettings;
  onSaved: () => void | Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '保存失败，请重试。';
}

export default function AgentSection({ agent, onSaved }: AgentSectionProps) {
  const [enabled, setEnabled] = useState(agent.mcp_enabled);
  const [maxMb, setMaxMb] = useState(String(agent.mcp_max_upload_mb));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mcpUrl = `${window.location.origin}/api/v1/mcp`;
  const parsedMaxMb = Number(maxMb);
  const validMaxMb = Number.isInteger(parsedMaxMb) && parsedMaxMb >= 1 && parsedMaxMb <= 512;

  useEffect(() => {
    setEnabled(agent.mcp_enabled);
    setMaxMb(String(agent.mcp_max_upload_mb));
  }, [agent.mcp_enabled, agent.mcp_max_upload_mb]);

  const handleSave = async () => {
    if (!validMaxMb) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put('/settings', { agent: { mcp_enabled: enabled, mcp_max_upload_mb: parsedMaxMb } });
      await onSaved();
      setNotice('已保存');
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white shadow rounded-lg p-4 md:p-6 mb-6" aria-labelledby="agent-heading">
      <h2 id="agent-heading" className="text-lg font-medium mb-1">Agent 接入（MCP）</h2>
      <p className="text-sm text-gray-600 mb-4">
        开启后，Agent 客户端可通过 MCP 操作本站。鉴权使用上方签发的 API Token；建议仅在 HTTPS 下使用，并只授予所需权限。
      </p>

      <label className="flex items-center gap-2 text-sm mb-4 min-h-8">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        启用 MCP 端点
      </label>

      <label className="block text-sm mb-4">
        <span className="block text-gray-700 mb-1">MCP 单文件大小上限（MB）</span>
        <input
          aria-label="MCP 单文件大小上限（MB）"
          type="number"
          min={1}
          max={512}
          value={maxMb}
          onChange={(event) => setMaxMb(event.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md w-36"
        />
        <span className="block text-xs text-gray-500 mt-1">每个上传分块最多 8 MB。</span>
      </label>

      <div className="text-sm mb-4 min-w-0">
        <span className="block text-gray-700 mb-1">MCP 端点地址</span>
        <code className="block min-w-0 px-3 py-2 bg-gray-50 border rounded text-xs break-all">{mcpUrl}</code>
        <p className="text-xs text-gray-500 mt-2 break-words">
          客户端使用 HTTP Authorization Header：Bearer fs_api_…；不要把 Token 放入 URL 或发送给第三方。
        </p>
      </div>

      {error && <p role="alert" className="text-red-600 text-sm mb-3 break-words">{error}</p>}
      {notice && <p role="status" className="text-green-700 text-sm mb-3">{notice}</p>}
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || !validMaxMb}
        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? '保存中...' : '保存 MCP 设置'}
      </button>
    </section>
  );
}
