import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { FolderNode } from '@filestation/shared';

interface FolderTreeProps {
  selectedFolderId: string | null; // null = 根目录
  onSelect: (folderId: string | null) => void;
  refreshKey: number;
}

export default function FolderTree({ selectedFolderId, onSelect, refreshKey }: FolderTreeProps) {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null | 'root'>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState('');

  const loadTree = useCallback(async () => {
    try {
      const response = await api.get<FolderNode[]>('/folders/tree');
      setTree(response.data!);
    } catch (err: any) {
      setError(err.message || '加载文件夹失败');
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree, refreshKey]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async (parentId: string | null) => {
    if (!inputValue.trim()) { setCreating(null); return; }
    try {
      await api.post('/folders', { name: inputValue.trim(), parent_id: parentId });
      setCreating(null);
      setInputValue('');
      loadTree();
    } catch (err: any) {
      alert('创建失败: ' + err.message);
    }
  };

  const handleRename = async (id: string) => {
    if (!inputValue.trim()) { setRenaming(null); return; }
    try {
      await api.patch(`/folders/${id}`, { name: inputValue.trim() });
      setRenaming(null);
      setInputValue('');
      loadTree();
    } catch (err: any) {
      alert('重命名失败: ' + err.message);
    }
  };

  const handleDelete = async (node: FolderNode) => {
    if (!confirm(`删除文件夹「${node.name}」？仅允许删除空文件夹。`)) return;
    try {
      await api.delete(`/folders/${node.id}`);
      if (selectedFolderId === node.id) onSelect(null);
      loadTree();
    } catch (err: any) {
      alert('删除失败: ' + err.message);
    }
  };

  const renderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const isSelected = selectedFolderId === node.id;
    const isExpanded = expanded.has(node.id);
    const hasChildren = (node.children?.length ?? 0) > 0;

    return (
      <div key={node.id}>
        <div
          className={`flex items-center group px-2 py-1 rounded cursor-pointer text-sm ${
            isSelected ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isExpanded ? '折叠' : '展开'} ${node.name}`}
              aria-expanded={isExpanded}
              className="-ml-3 -mr-4 min-h-11 min-w-11 w-11 shrink-0 pl-3 text-left text-gray-400 rounded hover:bg-gray-100"
              onClick={() => toggleExpand(node.id)}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span aria-hidden="true" className="w-4 shrink-0" />
          )}

          {renaming === node.id ? (
            <input
              autoFocus
              className="flex-1 px-1 border rounded text-sm"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={() => handleRename(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(node.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={`选择文件夹 ${node.name}`}
              aria-pressed={isSelected}
              className="flex-1 min-w-0 min-h-11 truncate text-left"
              onClick={() => onSelect(node.id)}
            >
              {node.name}
            </button>
          )}

          <span
            role="group"
            aria-label={`${node.name}操作`}
            className="flex md:hidden md:group-hover:flex md:group-focus-within:flex shrink-0 space-x-1 text-xs text-gray-500"
          >
            <button
              type="button"
              aria-label={`为 ${node.name} 新建子文件夹`}
              title="新建子文件夹"
              className="min-h-11 min-w-11 rounded hover:bg-gray-100"
              onClick={() => { setCreating(node.id); setInputValue(''); setExpanded((p) => new Set(p).add(node.id)); }}
            >
              +
            </button>
            <button
              type="button"
              aria-label={`重命名 ${node.name}`}
              title="重命名"
              className="min-h-11 min-w-11 rounded hover:bg-gray-100"
              onClick={() => { setRenaming(node.id); setInputValue(node.name); }}
            >
              ✎
            </button>
            <button
              type="button"
              aria-label={`删除 ${node.name}`}
              title="删除"
              className="min-h-11 min-w-11 rounded hover:bg-gray-100"
              onClick={() => handleDelete(node)}
            >
              ×
            </button>
          </span>
        </div>

        {creating === node.id && (
          <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }} className="py-1">
            <input
              autoFocus
              placeholder="新文件夹名称"
              className="w-full px-1 border rounded text-sm"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={() => handleCreate(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate(node.id);
                if (e.key === 'Escape') setCreating(null);
              }}
            />
          </div>
        )}

        {isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="w-full md:w-64 flex-shrink-0 bg-white border-r border-gray-200 p-2 overflow-y-auto">
      <div className="flex justify-between items-center px-2 py-1 mb-2">
        <span className="text-xs font-semibold text-gray-500 uppercase">文件夹</span>
        <button
          type="button"
          aria-label="新建根文件夹"
          className="min-h-11 px-2 text-sm text-blue-600 hover:text-blue-800"
          title="新建根文件夹"
          onClick={() => { setCreating('root'); setInputValue(''); }}
        >
          + 新建
        </button>
      </div>

      {/* v1.7 建议 b：两个独立视图——全部文件（null）与根目录（'root'，仅 folder_id IS NULL） */}
      <button
        type="button"
        aria-pressed={selectedFolderId === null}
        className={`w-full min-h-11 px-2 py-1 rounded text-left text-sm ${
          selectedFolderId === null ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
        }`}
        onClick={() => onSelect(null)}
      >
        全部文件
      </button>
      <button
        type="button"
        aria-pressed={selectedFolderId === 'root'}
        className={`w-full min-h-11 px-2 py-1 rounded text-left text-sm ${
          selectedFolderId === 'root' ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
        }`}
        onClick={() => onSelect('root')}
      >
        根目录（未归档）
      </button>

      {creating === 'root' && (
        <div className="px-2 py-1">
          <input
            autoFocus
            placeholder="新文件夹名称"
            className="w-full px-1 border rounded text-sm"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => handleCreate(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate(null);
              if (e.key === 'Escape') setCreating(null);
            }}
          />
        </div>
      )}

      {error && <div className="text-red-600 text-xs px-2">{error}</div>}
      {tree.map((node) => renderNode(node, 1))}
    </div>
  );
}
