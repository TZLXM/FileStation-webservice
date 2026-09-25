import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { FileMetadata, PaginatedResponse } from '@filestation/shared';
import AppLayout from '../components/AppLayout';
import FileUpload from '../components/FileUpload';
import FolderTree from '../components/FolderTree';
import FileList from '../components/FileList';

export default function FilesPage() {
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null); // null=全部, 'root'=根目录, uuid=指定文件夹
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const skipDrawerFocusRestoreRef = useRef(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);

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

  // 修复竞态：仅在认证 token 就绪后才加载（防页面重载时 checkAuth 未完成就发 401 请求）
  useEffect(() => {
    if (isAuthenticated && accessToken) {
      loadFiles().catch((err) => console.error('Failed to load files:', err));
    }
  }, [loadFiles, isAuthenticated, accessToken]);

  useEffect(() => {
    if (!drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        return;
      }

      if (event.key !== 'Tab') return;

      const drawer = drawerRef.current;
      if (!drawer) return;

      const focusableElements = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

      if (focusableElements.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey) {
        if (activeElement === first || activeElement === drawer || !drawer.contains(activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeElement === last || activeElement === drawer || !drawer.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = 'hidden';
    drawerRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      if (skipDrawerFocusRestoreRef.current) {
        skipDrawerFocusRestoreRef.current = false;
      } else {
        previousFocus?.focus();
      }
    };
  }, [drawerOpen]);

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 768px)');
    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches && drawerRef.current) {
        // The hamburger is hidden at desktop width, so don't restore focus to it.
        skipDrawerFocusRestoreRef.current = true;
        setDrawerOpen(false);
      }
    };

    desktopQuery.addEventListener('change', handleBreakpointChange);
    return () => desktopQuery.removeEventListener('change', handleBreakpointChange);
  }, []);

  const handleSelectFolder = (id: string | null) => {
    setSelectedFolderId(id);
    setPage(1);
    setDrawerOpen(false);
  };

  return (
    <AppLayout onFolderToggle={() => setDrawerOpen(true)}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {drawerOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              data-testid="folder-drawer-backdrop"
              aria-hidden="true"
              className="absolute inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="folder-drawer-title"
              tabIndex={-1}
              className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl overflow-y-auto outline-none"
            >
              <h2 id="folder-drawer-title" className="sr-only">文件夹</h2>
              <div className="flex justify-end px-2 pt-2">
                <button
                  type="button"
                  aria-label="关闭文件夹"
                  className="min-h-10 min-w-10 rounded text-gray-600 hover:bg-gray-100"
                  onClick={() => setDrawerOpen(false)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              <FolderTree
                selectedFolderId={selectedFolderId}
                onSelect={handleSelectFolder}
                refreshKey={treeRefreshKey}
              />
            </div>
          </div>
        )}
        <aside aria-label="文件夹列表" className="hidden md:block h-full">
          <FolderTree
            selectedFolderId={selectedFolderId}
            onSelect={handleSelectFolder}
            refreshKey={treeRefreshKey}
          />
        </aside>
        <main className="flex-1 min-w-0 p-4 md:p-6 overflow-y-auto">
          <div className="mb-6">
            <FileUpload onUploadComplete={loadFiles} folderId={selectedFolderId === 'root' ? null : selectedFolderId} />
          </div>
          <FileList files={files} total={total} page={page} onPageChange={setPage} onChanged={loadFiles} />
        </main>
      </div>
    </AppLayout>
  );
}
