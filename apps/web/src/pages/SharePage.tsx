import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ShareInfo } from '@filestation/shared';

export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [password, setPassword] = useState('');
  const [downloadToken, setDownloadToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadShareInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadShareInfo = async () => {
    try {
      const response = await api.get<ShareInfo>(`/shares/${id}`);
      setShareInfo(response.data!);
      if (!response.data!.requires_password) {
        // 免密分享：统一 access 端点（空 body）
        const accessResponse = await api.post<{ download_token: string }>(`/shares/${id}/access`, {});
        setDownloadToken(accessResponse.data!.download_token);
      }
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      // v1.6：统一 access 端点（带 password），替代旧 /verify
      const response = await api.post<{ download_token: string }>(`/shares/${id}/access`, { password });
      setDownloadToken(response.data!.download_token);
    } catch (err: any) {
      setError(err.message || '密码错误');
    }
  };

  const handleDownload = async () => {
    if (!downloadToken) return;

    try {
      // 获取下载票据
      const response = await api.post<{ ticket_url: string; expires_at: string }>(
        `/shares/${id}/download-ticket`,
        {},
        { 'Authorization': `Bearer ${downloadToken}` },
      );

      // 使用票据 URL 下载
      const a = document.createElement('a');
      a.href = response.data!.ticket_url;
      a.download = shareInfo?.filename || 'download';
      a.click();
    } catch (err: any) {
      alert('下载失败: ' + err.message);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  }

  if (error && !shareInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-red-600">{error}</div>
      </div>
    );
  }

  if (!shareInfo) {
    return <div className="min-h-screen flex items-center justify-center">分享不存在</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full min-w-0 p-8 bg-white rounded-lg shadow">
        <h2 className="text-xl md:text-2xl font-bold mb-4 break-words">{shareInfo.filename}</h2>
        <p className="text-gray-600 mb-4">大小: {formatSize(shareInfo.size)}</p>

        {shareInfo.requires_password && !downloadToken && (
          <form onSubmit={handleVerify} className="space-y-4">
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">密码</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              验证
            </button>
          </form>
        )}

        {downloadToken && (
          <button
            onClick={handleDownload}
            className="w-full py-3 px-4 bg-green-600 text-white rounded-md hover:bg-green-700"
          >
            下载文件
          </button>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
