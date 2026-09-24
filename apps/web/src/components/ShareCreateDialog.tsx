import { useState } from 'react';
import { api } from '../lib/api';

interface ShareCreateDialogProps {
  fileId: string;
  filename: string;
  onClose: () => void;
}

export default function ShareCreateDialog({ fileId, filename, onClose }: ShareCreateDialogProps) {
  const [protection, setProtection] = useState<'none' | 'password'>('none');
  const [password, setPassword] = useState('');
  const [maxDownloads, setMaxDownloads] = useState<string>('');
  const [expiresInHours, setExpiresInHours] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (protection === 'password' && password.length < 4) {
      setError('密码至少 4 位');
      return;
    }

    setCreating(true);
    try {
      const body: Record<string, unknown> = { file_id: fileId, protection };
      if (protection === 'password') body.password = password;
      if (maxDownloads) body.max_downloads = parseInt(maxDownloads, 10);
      if (expiresInHours) {
        body.expires_at = new Date(Date.now() + parseInt(expiresInHours, 10) * 3600_000).toISOString();
      }

      const response = await api.post<{ share_id: string; share_url: string }>('/shares', body);
      setShareUrl(`${window.location.origin}${response.data!.share_url}`);
    } catch (err: any) {
      setError(err.message || '创建分享失败');
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    alert('已复制到剪贴板');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-create-title"
        className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="share-create-title" className="text-lg font-semibold mb-1">创建分享</h3>
        <p className="text-sm text-gray-500 mb-4 truncate">{filename}</p>

        {shareUrl ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">分享链接</label>
              <div className="flex space-x-2">
                <input readOnly value={shareUrl} className="min-w-0 flex-1 px-3 py-2 border rounded text-sm bg-gray-50" />
                <button onClick={copyToClipboard} className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                  复制
                </button>
              </div>
            </div>
            <button onClick={onClose} className="w-full py-2 border rounded text-sm hover:bg-gray-50">关闭</button>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            {error && <div className="text-red-600 text-sm">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">访问保护</label>
              <div className="flex space-x-4 text-sm">
                <label className="flex items-center space-x-1">
                  <input type="radio" checked={protection === 'none'} onChange={() => setProtection('none')} />
                  <span>免密</span>
                </label>
                <label className="flex items-center space-x-1">
                  <input type="radio" checked={protection === 'password'} onChange={() => setProtection('password')} />
                  <span>密码保护</span>
                </label>
              </div>
            </div>

            {protection === 'password' && (
              <div>
                <label className="block text-sm font-medium text-gray-700">访问密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border rounded text-sm"
                  required
                  minLength={4}
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700">最大下载次数（留空不限）</label>
              <input
                type="number"
                min={1}
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border rounded text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">有效期（小时，留空永久）</label>
              <input
                type="number"
                min={1}
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border rounded text-sm"
              />
            </div>

            <div className="flex space-x-2">
              <button type="submit" disabled={creating} className="flex-1 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
                {creating ? '创建中...' : '创建分享'}
              </button>
              <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm hover:bg-gray-50">取消</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
