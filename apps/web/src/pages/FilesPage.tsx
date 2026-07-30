import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { FileMetadata, PaginatedResponse } from '@filestation/shared';
import FileUpload from '../components/FileUpload';
import FolderTree from '../components/FolderTree';
import FileList from '../components/FileList';

export default function FilesPage() {
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null); // null=全部, 'root'=根目录, uuid=指定文件夹
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const logout = useAuthStore((s) => s.logout);
  const username = useAuthStore((s) => s.username);

  const loadFiles = useCallback(async () => {
    // v1.7 建议 b：根目录传 'root'（folder_id IS NULL），选中文件夹传 id，"全部"视图不传
    // selectedFolderId === 'root' 表示根目录视图；null 表示全部文件；uuid 表示指定文件夹
    const folderParam = selectedFolderId ? `&folder_id=${selectedFolderId}` : '';
    const response = await api.get<PaginatedResponse<FileMetadata>>(
      `/files?page=${page}&page_size=20${folderParam}`,
    );
    setFiles(response.data!.items);
    setTotal(response.data!.total);
  }, [page, selectedFolderId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleSelectFolder = (id: string | null) => {
    setSelectedFolderId(id);
    setPage(1);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow">
        <div className="px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold">FileStation</h1>
          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-600">{username}</span>
            <button onClick={() => logout()} className="text-sm text-red-600 hover:text-red-800">退出</button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelect={handleSelectFolder}
          refreshKey={treeRefreshKey}
        />
        <main className="flex-1 p-6 overflow-y-auto">
          <div className="mb-6">
            <FileUpload onUploadComplete={loadFiles} folderId={selectedFolderId === 'root' ? null : selectedFolderId} />
          </div>
          <FileList files={files} total={total} page={page} onPageChange={setPage} onChanged={loadFiles} />
        </main>
      </div>
    </div>
  );
}
