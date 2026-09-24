import { useState } from 'react';
import { api } from '../lib/api';
import { FileMetadata } from '@filestation/shared';
import ShareCreateDialog from './ShareCreateDialog';
import MoveFileDialog from './MoveFileDialog';

interface FileListProps {
  files: FileMetadata[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onChanged: () => void;
}

interface ShareItem {
  id: string;
  share_url: string;
  protection: 'none' | 'password';
  status: 'active' | 'revoked';
  max_downloads: number | null;
  used_downloads: number;
  expires_at: string | null;
}

export default function FileList({ files, total, page, onPageChange, onChanged }: FileListProps) {
  const [shareDialogFile, setShareDialogFile] = useState<FileMetadata | null>(null);
  const [moveDialogFile, setMoveDialogFile] = useState<FileMetadata | null>(null);
  const [expandedShares, setExpandedShares] = useState<Record<string, ShareItem[]>>({});

  const handleDownload = async (file: FileMetadata) => {
    try {
      await api.downloadFile(file.id, file.filename);
    } catch (err: any) {
      alert('下载失败: ' + err.message);
    }
  };

  const handleExtend = async (file: FileMetadata) => {
    const input = prompt('延长小时数:', '24');
    if (!input) return;
    const hours = parseInt(input, 10);
    if (isNaN(hours) || hours <= 0) { alert('无效小时数'); return; }
    try {
      await api.post(`/files/${file.id}/extend`, { hours });
      onChanged();
    } catch (err: any) {
      alert('延长失败: ' + err.message);
    }
  };

  const handleSetPermanent = async (file: FileMetadata) => {
    try {
      await api.patch(`/files/${file.id}`, { expires_at: null }); // v1.6 后端支持显式 null
      onChanged();
    } catch (err: any) {
      alert('操作失败: ' + err.message);
    }
  };

  const handleDelete = async (file: FileMetadata) => {
    if (!confirm(`确认删除「${file.filename}」？文件将进入清理队列。`)) return;
    try {
      await api.delete(`/files/${file.id}`);
      onChanged();
    } catch (err: any) {
      alert('删除失败: ' + err.message);
    }
  };

  const toggleShares = async (file: FileMetadata) => {
    if (expandedShares[file.id]) {
      setExpandedShares((prev) => { const n = { ...prev }; delete n[file.id]; return n; });
      return;
    }
    try {
      const response = await api.get<ShareItem[]>(`/shares?file_id=${file.id}`);
      setExpandedShares((prev) => ({ ...prev, [file.id]: response.data! }));
    } catch (err: any) {
      alert('加载分享失败: ' + err.message);
    }
  };

  const handleRevokeShare = async (fileId: string, shareId: string) => {
    if (!confirm('吊销该分享？已有下载票据将立即失效。')) return;
    try {
      await api.delete(`/shares/${shareId}`);
      const response = await api.get<ShareItem[]>(`/shares?file_id=${fileId}`);
      setExpandedShares((prev) => ({ ...prev, [fileId]: response.data! }));
    } catch (err: any) {
      alert('吊销失败: ' + err.message);
    }
  };

  const renderShares = (file: FileMetadata) => {
    const shares = expandedShares[file.id];
    if (!shares) return null;
    if (shares.length === 0) return <span className="text-xs text-gray-400">暂无分享</span>;

    return (
      <ul className="space-y-1 mt-2">
        {shares.map((share) => (
          <li key={share.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs min-w-0">
            <span className="font-mono break-all min-w-0 max-w-full">{window.location.origin}{share.share_url}</span>
            <span>{share.protection === 'password' ? '密码' : '免密'}</span>
            <span>{share.used_downloads}{share.max_downloads !== null ? `/${share.max_downloads}` : ''} 次</span>
            <span>{share.expires_at ? new Date(share.expires_at).toLocaleString() : '永久'}</span>
            {share.status === 'revoked' ? (
              <span className="text-gray-400">已吊销</span>
            ) : (
              <button
                type="button"
                onClick={() => handleRevokeShare(file.id, share.id)}
                className="min-h-8 px-2 text-red-600 hover:underline"
              >
                吊销
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="space-y-3">
      <div className="md:hidden space-y-3">
        {files.map((file) => (
          <article key={file.id} aria-label={file.filename} className="bg-white shadow rounded-lg p-4 min-w-0">
            <div className="font-medium text-sm truncate" title={file.filename}>{file.filename}</div>
            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-1">
              <span>{formatSize(file.size)}</span>
              <span aria-hidden="true">·</span>
              <span>{file.expires_at ? new Date(file.expires_at).toLocaleDateString() : '永久'}</span>
              <span aria-hidden="true">·</span>
              <span>{file.download_count} 次下载</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-3 text-sm">
              <button type="button" onClick={() => handleDownload(file)} className="min-h-11 px-2 py-2 rounded text-blue-600 hover:bg-blue-50">下载</button>
              <button type="button" onClick={() => setShareDialogFile(file)} className="min-h-11 px-2 py-2 rounded text-green-600 hover:bg-green-50">分享</button>
              <button type="button" onClick={() => setMoveDialogFile(file)} className="min-h-11 px-2 py-2 rounded text-gray-600 hover:bg-gray-100">移动</button>
              <button type="button" onClick={() => handleExtend(file)} className="min-h-11 px-2 py-2 rounded text-gray-600 hover:bg-gray-100">延期</button>
              {file.expires_at && (
                <button type="button" onClick={() => handleSetPermanent(file)} className="min-h-11 px-2 py-2 rounded text-gray-600 hover:bg-gray-100">设为永久</button>
              )}
              <button type="button" onClick={() => toggleShares(file)} className="min-h-11 px-2 py-2 rounded text-gray-600 hover:bg-gray-100">
                {expandedShares[file.id] ? '收起' : '分享列表'}
              </button>
              <button type="button" onClick={() => handleDelete(file)} className="min-h-11 px-2 py-2 rounded text-red-600 hover:bg-red-50">删除</button>
            </div>
            {expandedShares[file.id] && <div className="mt-2 min-w-0">{renderShares(file)}</div>}
          </article>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto bg-white shadow rounded-lg">
        <table className="min-w-[900px] w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">文件名</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">大小</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">过期时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">下载次数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {files.map((file) => (
              <FragmentRow key={file.id}>
                <tr>
                  <td className="px-4 py-3 text-sm font-medium max-w-[280px] truncate" title={file.filename}>{file.filename}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{formatSize(file.size)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {file.expires_at ? new Date(file.expires_at).toLocaleString() : '永久'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{file.download_count}</td>
                  <td className="px-4 py-3 text-sm text-right space-x-2 whitespace-nowrap">
                    <button type="button" onClick={() => handleDownload(file)} className="text-blue-600 hover:underline">下载</button>
                    <button type="button" onClick={() => setMoveDialogFile(file)} className="text-gray-600 hover:underline">移动</button>
                    <button type="button" onClick={() => handleExtend(file)} className="text-gray-600 hover:underline">延期</button>
                    {file.expires_at && (
                      <button type="button" onClick={() => handleSetPermanent(file)} className="text-gray-600 hover:underline">设为永久</button>
                    )}
                    <button type="button" onClick={() => setShareDialogFile(file)} className="text-green-600 hover:underline">分享</button>
                    <button type="button" onClick={() => toggleShares(file)} className="text-gray-600 hover:underline">
                      {expandedShares[file.id] ? '收起' : '分享列表'}
                    </button>
                    <button type="button" onClick={() => handleDelete(file)} className="text-red-600 hover:underline">删除</button>
                  </td>
                </tr>
                {expandedShares[file.id] && (
                  <tr>
                    <td colSpan={5} className="px-8 py-2 bg-gray-50 min-w-0">
                      {renderShares(file)}
                    </td>
                  </tr>
                )}
              </FragmentRow>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 flex flex-wrap justify-between items-center gap-3 text-sm text-gray-500 bg-white shadow rounded-lg">
        <span>共 {total} 个文件</span>
        <div className="flex gap-3">
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="min-h-10 px-2 disabled:opacity-40">上一页</button>
          <button type="button" disabled={page * 20 >= total} onClick={() => onPageChange(page + 1)} className="min-h-10 px-2 disabled:opacity-40">下一页</button>
        </div>
      </div>

      {shareDialogFile && (
        <ShareCreateDialog
          fileId={shareDialogFile.id}
          filename={shareDialogFile.filename}
          onClose={() => setShareDialogFile(null)}
        />
      )}
      {moveDialogFile && (
        <MoveFileDialog
          file={moveDialogFile}
          onClose={() => setMoveDialogFile(null)}
          onMoved={() => { setMoveDialogFile(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
