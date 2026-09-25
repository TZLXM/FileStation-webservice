// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FileMetadata } from '@filestation/shared';
import FileList from '../components/FileList';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    downloadFile: vi.fn(async () => undefined),
  },
}));

const mockedApi = vi.mocked(api);

function expectMobileDialogGutters(dialog: HTMLElement) {
  const overlay = dialog.parentElement;
  expect(overlay).not.toBeNull();
  expect(overlay).toHaveClass('p-4');
  expect(dialog).toHaveClass('w-full', 'max-w-md');
  expect(dialog).not.toHaveClass('mx-4');
}

const file: FileMetadata = {
  id: 'file-1',
  filename: 'project-archive-with-a-long-name.zip',
  size: 1024,
  mime_type: 'application/zip',
  hash_sha256: null,
  status: 'active',
  expires_at: '2030-01-01T00:00:00.000Z',
  folder_id: null,
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  download_count: 2,
};

describe('FileList responsive views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => '24'));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a mobile card alongside the desktop table with all file actions reachable', () => {
    const { container } = render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    const card = screen.getByRole('article', { name: file.filename });
    expect(card).toHaveClass('bg-white', 'rounded-lg');
    expect(within(card).getByText(file.filename)).toHaveClass('truncate');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(card.parentElement).toHaveClass('md:hidden');
    expect(screen.getByRole('cell', { name: file.filename })).toHaveClass('truncate');

    for (const action of ['下载', '分享', '移动', '延期', '设为永久', '分享列表', '删除']) {
      expect(within(card).getByRole('button', { name: action })).toBeInTheDocument();
    }
  });

  it('uses the same expanded share details in the mobile card and desktop table', async () => {
    mockedApi.get.mockResolvedValue({
      data: [{
        id: 'share-1',
        share_url: '/s/share-1',
        protection: 'password',
        status: 'active',
        max_downloads: 5,
        used_downloads: 2,
        expires_at: null,
      }],
    } as never);
    const { container } = render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '分享列表' }));

    const url = `${window.location.origin}/s/share-1`;
    expect(await screen.findAllByText(url)).toHaveLength(2);
    expect(screen.getAllByText('2/5 次')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '吊销' })).toHaveLength(2);
    expect(container.querySelectorAll('li.flex.flex-wrap')).toHaveLength(2);
  });

  it('opens share creation from a mobile card action', () => {
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '分享' }));

    const dialog = screen.getByRole('dialog', { name: '创建分享' });
    expectMobileDialogGutters(dialog);
  });

  it('opens the move dialog from a mobile card action with viewport gutters', async () => {
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '移动' }));

    const dialog = await screen.findByRole('dialog', { name: '移动文件' });
    expectMobileDialogGutters(dialog);
  });

  it('downloads from the mobile card action', async () => {
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '下载' }));

    expect(mockedApi.downloadFile).toHaveBeenCalledWith(file.id, file.filename);
  });

  it('extends from the mobile card with the requested hours and notifies the page', async () => {
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '延期' }));

    expect(window.prompt).toHaveBeenCalledWith('延长小时数:', '24');
    expect(mockedApi.post).toHaveBeenCalledWith('/files/file-1/extend', { hours: 24 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('sets a mobile-card file to permanent with an explicit null expiry', async () => {
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '设为永久' }));

    expect(mockedApi.patch).toHaveBeenCalledWith('/files/file-1', { expires_at: null });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('loads and collapses the mobile share list through the file-specific API path', async () => {
    mockedApi.get.mockResolvedValue({ data: [{
      id: 'share-1',
      share_url: '/s/share-1',
      protection: 'none',
      status: 'active',
      max_downloads: null,
      used_downloads: 0,
      expires_at: null,
    }] } as never);
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);
    const card = screen.getByRole('article', { name: file.filename });

    fireEvent.click(within(card).getByRole('button', { name: '分享列表' }));

    expect(await within(card).findByText(`${window.location.origin}/s/share-1`)).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledWith('/shares?file_id=file-1');
    fireEvent.click(within(card).getByRole('button', { name: '收起' }));
    expect(within(card).queryByText(`${window.location.origin}/s/share-1`)).not.toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('confirms mobile-card deletion before deleting and notifying the page', async () => {
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '删除' }));

    expect(window.confirm).toHaveBeenCalledWith(`确认删除「${file.filename}」？文件将进入清理队列。`);
    expect(mockedApi.delete).toHaveBeenCalledWith('/files/file-1');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does not delete or notify when mobile-card deletion is cancelled', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '删除' }));

    expect(mockedApi.delete).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('confirms share revocation, deletes it, then refreshes the current file share list', async () => {
    const activeShare = {
      id: 'share-1',
      share_url: '/s/share-1',
      protection: 'none' as const,
      status: 'active' as const,
      max_downloads: null,
      used_downloads: 0,
      expires_at: null,
    };
    mockedApi.get
      .mockResolvedValueOnce({ data: [activeShare] } as never)
      .mockResolvedValueOnce({ data: [] } as never);
    const onChanged = vi.fn();
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={onChanged} />);
    const card = screen.getByRole('article', { name: file.filename });
    fireEvent.click(within(card).getByRole('button', { name: '分享列表' }));

    fireEvent.click(await within(card).findByRole('button', { name: '吊销' }));

    expect(window.confirm).toHaveBeenCalledWith('吊销该分享？已有下载票据将立即失效。');
    expect(mockedApi.delete).toHaveBeenCalledWith('/shares/share-1');
    expect(mockedApi.get).toHaveBeenNthCalledWith(1, '/shares?file_id=file-1');
    await waitFor(() => expect(mockedApi.get).toHaveBeenNthCalledWith(2, '/shares?file_id=file-1'));
    expect(await within(card).findByText('暂无分享')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('does not revoke a share when the mobile-card confirmation is cancelled', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mockedApi.get.mockResolvedValue({ data: [{
      id: 'share-1',
      share_url: '/s/share-1',
      protection: 'none',
      status: 'active',
      max_downloads: null,
      used_downloads: 0,
      expires_at: null,
    }] } as never);
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);
    const card = screen.getByRole('article', { name: file.filename });
    fireEvent.click(within(card).getByRole('button', { name: '分享列表' }));

    fireEvent.click(await within(card).findByRole('button', { name: '吊销' }));

    expect(window.confirm).toHaveBeenCalledWith('吊销该分享？已有下载票据将立即失效。');
    expect(mockedApi.delete).not.toHaveBeenCalled();
    expect(mockedApi.get).toHaveBeenCalledTimes(1);
  });
});
