// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

    const heading = screen.getByRole('heading', { name: '创建分享' });
    expect(heading).toBeInTheDocument();
    expect(heading.parentElement).toHaveClass('mx-4');
  });

  it('opens the move dialog from a mobile card action with mobile margins', async () => {
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '移动' }));

    expect((await screen.findByText('移动文件')).parentElement).toHaveClass('mx-4');
  });

  it('downloads from the mobile card action', async () => {
    render(<FileList files={[file]} total={1} page={1} onPageChange={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(within(screen.getByRole('article', { name: file.filename })).getByRole('button', { name: '下载' }));

    expect(mockedApi.downloadFile).toHaveBeenCalledWith(file.id, file.filename);
  });
});
