import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { FileMetadata, FolderNode } from '@filestation/shared';

interface MoveFileDialogProps {
  file: FileMetadata;
  onClose: () => void;
  onMoved: () => void;
}

export default function MoveFileDialog({ file, onClose, onMoved }: MoveFileDialogProps) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [selectedId, setSelectedId] = useState<string>(file.folder_id ?? '');
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const response = await api.get<FolderNode[]>('/folders');
        setFolders(response.data!);
      } catch (err) {
        console.error('Failed to load folders:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleMove = async () => {
    setMoving(true);
    try {
      // '' = 根目录（null）；folder_id 显式 null 移到根目录
      await api.patch(`/files/${file.id}`, { folder_id: selectedId === '' ? null : selectedId });
      onMoved();
    } catch (err: any) {
      alert('移动失败: ' + err.message);
      setMoving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-file-title"
        className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="move-file-title" className="text-lg font-semibold mb-1">移动文件</h3>
        <p className="text-sm text-gray-500 mb-4 truncate">{file.filename}</p>

        {loading ? (
          <div className="text-sm text-gray-500">加载文件夹...</div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">目标文件夹</label>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="block w-full px-3 py-2 border rounded text-sm"
              >
                <option value="">根目录</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="flex space-x-2">
              <button onClick={handleMove} disabled={moving} className="flex-1 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
                {moving ? '移动中...' : '移动'}
              </button>
              <button onClick={onClose} className="px-4 py-2 border rounded text-sm hover:bg-gray-50">取消</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
