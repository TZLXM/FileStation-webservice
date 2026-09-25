import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiTokenInfo, ApiTokenScope, CreatedApiToken } from '@filestation/shared';
import { api } from '../../lib/api';

// The linked shared package is CommonJS and Vite does not expose its runtime named exports.
// Keep the client choices type-checked here and lock them to shared at the UI contract test.
const API_TOKEN_SCOPES: readonly ApiTokenScope[] = [
  'files:read', 'files:write',
  'shares:read', 'shares:write',
  'folders:read', 'folders:write',
];

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<ApiTokenScope[]>(['files:read']);
  const [expiresDays, setExpiresDays] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const listRequestVersion = useRef(0);

  const loadTokens = useCallback(async () => {
    const requestId = ++listRequestVersion.current;
    setLoading(true);
    setListError('');
    try {
      const response = await api.get<ApiTokenInfo[]>('/api-tokens');
      if (requestId !== listRequestVersion.current) return;
      setTokens(Array.isArray(response.data) ? response.data : []);
    } catch (loadError) {
      if (requestId !== listRequestVersion.current) return;
      setListError(getErrorMessage(loadError, '加载 API Token 失败'));
    } finally {
      if (requestId === listRequestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTokens();
    return () => {
      listRequestVersion.current += 1;
    };
  }, [loadTokens]);

  const toggleScope = (scope: ApiTokenScope) => {
    setSelectedScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  const hasExpiresDays = expiresDays !== '';
  const parsedExpiresDays = hasExpiresDays ? Number(expiresDays) : null;
  const validName = name.trim().length > 0 && name.trim().length <= 64;
  const validScopes = selectedScopes.length > 0;
  const validExpiresDays = !hasExpiresDays || (
    /^\d+$/.test(expiresDays)
    && parsedExpiresDays !== null
    && Number.isInteger(parsedExpiresDays)
    && parsedExpiresDays >= 1
    && parsedExpiresDays <= 365
  );

  const handleCreate = async () => {
    if (!validName || !validScopes || !validExpiresDays) return;
    setActionError('');
    setCopyError('');
    setCopyMessage('');
    setCreated(null);
    setCreating(true);
    try {
      const payload = {
        name: name.trim(),
        scopes: selectedScopes,
        ...(parsedExpiresDays === null ? {} : { expires_in_days: parsedExpiresDays }),
      };
      const response = await api.post<CreatedApiToken>('/api-tokens', payload);
      if (!response.data?.token) throw new Error('服务器未返回新 Token');
      setCreated(response.data);
      setName('');
      await loadTokens();
    } catch (createError) {
      setActionError(getErrorMessage(createError, '创建 Token 失败'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
      await navigator.clipboard.writeText(created.token);
      setCopyMessage('已复制到剪贴板');
      setCopyError('');
    } catch {
      setCopyMessage('');
      setCopyError('复制失败，请检查浏览器剪贴板权限后重试。');
    }
  };

  const handleRevoke = async (token: ApiTokenInfo) => {
    if (!window.confirm(`吊销「${token.name}」？使用它的 Agent 将立即失效。`)) return;
    setActionError('');
    setRevokingId(token.id);
    try {
      await api.delete(`/api-tokens/${token.id}`);
      await loadTokens();
    } catch (revokeError) {
      setActionError(getErrorMessage(revokeError, '吊销 Token 失败'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section className="bg-white shadow rounded-lg p-4 md:p-6 mb-6" aria-labelledby="api-token-heading">
      <h2 id="api-token-heading" className="text-lg font-medium mb-1">API Token</h2>
      <p className="text-sm text-gray-500 mb-4">供脚本或 Agent 调用 API。完整明文只在签发后显示一次；请按需授予权限并妥善保存。</p>

      {created && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded" aria-label="新签发的 Token">
          <p className="text-sm text-green-800 mb-2">Token 已创建。请立即复制，关闭或离开此页面后将无法再次查看。</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              aria-label="新签发的 Token（仅此一次）"
              readOnly
              value={created.token}
              className="min-w-0 flex-1 px-2 py-2 border rounded text-sm font-mono bg-white"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" onClick={() => void handleCopy()} className="px-3 py-2 bg-blue-600 text-white rounded text-sm">
              复制 Token
            </button>
          </div>
          {copyMessage && <p role="status" className="text-sm text-green-700 mt-2">{copyMessage}</p>}
          {copyError && <p role="alert" className="text-sm text-red-600 mt-2 break-words">{copyError}</p>}
          <button type="button" onClick={() => { setCreated(null); setCopyMessage(''); }} className="text-xs text-gray-600 mt-2 underline">
            我已保存，关闭
          </button>
        </div>
      )}

      <div className="space-y-3 mb-4">
        <label className="block text-sm">
          <span className="sr-only">Token 名称</span>
          <input
            aria-label="Token 名称"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            placeholder="Token 名称（如 claude-desktop）"
            className="block w-full px-3 py-2 border border-gray-300 rounded-md"
          />
        </label>
        <fieldset>
          <legend className="text-sm text-gray-700 mb-2">权限范围</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {API_TOKEN_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-1">
                <input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <label className="block text-sm text-gray-700">
            <span className="block mb-1">有效期（天，留空永久）</span>
            <input
              aria-label="有效期（天，留空永久）"
              value={expiresDays}
              onChange={(event) => setExpiresDays(event.target.value)}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="px-3 py-2 border border-gray-300 rounded-md w-full sm:w-48"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!validName || !validScopes || !validExpiresDays || creating}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? '签发中...' : '签发 Token'}
          </button>
        </div>
      </div>

      {actionError && <p role="alert" className="text-red-600 text-sm mb-3 break-words">{actionError}</p>}
      {listError && <p role="alert" className="text-red-600 text-sm mb-3 break-words">{listError}</p>}

      {loading ? (
        <p role="status" className="text-sm text-gray-500">正在加载 Token...</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {tokens.map((token) => (
            <li key={token.id} className="py-3 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <span className="min-w-0 max-w-full font-medium break-all">{token.name}</span>
              <span className="font-mono text-gray-500 break-all">{token.token_prefix}…</span>
              <span className="text-gray-500 text-xs break-words">{token.scopes.join(', ')}</span>
              <span className="text-gray-500 text-xs">{token.expires_at ? `${new Date(token.expires_at).toLocaleDateString()} 到期` : '永久'}</span>
              {token.revoked_at ? (
                <span className="text-gray-500 text-xs">已吊销</span>
              ) : (
                <button
                  type="button"
                  aria-label={`吊销 ${token.name}`}
                  disabled={revokingId === token.id}
                  onClick={() => void handleRevoke(token)}
                  className="text-red-600 text-xs ml-auto min-h-8 disabled:opacity-50"
                >
                  {revokingId === token.id ? '吊销中...' : '吊销'}
                </button>
              )}
            </li>
          ))}
          {tokens.length === 0 && <li className="py-3 text-gray-500">暂无 Token</li>}
        </ul>
      )}
    </section>
  );
}
