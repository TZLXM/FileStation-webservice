// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FolderTree from '../components/FolderTree';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: [{
      id: 'folder-1',
      name: '文档',
      parent_id: null,
      children: [{ id: 'folder-2', name: '子文档', parent_id: 'folder-1', children: [] }],
    }] })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    downloadFile: vi.fn(async () => undefined),
  },
}));

describe('FolderTree touch actions', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it('keeps folder actions visible by default and lets the user start a child folder from touch controls', async () => {
    const { container } = render(<FolderTree selectedFolderId={null} onSelect={vi.fn()} refreshKey={0} />);
    const folder = await screen.findByText('文档');
    const row = folder.parentElement;
    const actions = within(row as HTMLElement).getByRole('group', { name: '文档操作' });

    expect(container.firstElementChild).toHaveClass('w-full', 'md:w-64');
    expect(actions).toHaveClass('flex', 'md:hidden');
    expect(actions).not.toHaveClass('hidden');
    fireEvent.click(within(actions).getByRole('button', { name: '为 文档 新建子文件夹' }));

    expect(await screen.findByPlaceholderText('新文件夹名称')).toBeInTheDocument();
  });

  it('uses named keyboard-operable buttons for folder selection and expansion', async () => {
    const onSelect = vi.fn();
    render(<FolderTree selectedFolderId={null} onSelect={onSelect} refreshKey={0} />);

    const allFiles = await screen.findByRole('button', { name: '全部文件' });
    const rootFolder = screen.getByRole('button', { name: '根目录（未归档）' });
    const selectFolder = screen.getByRole('button', { name: '选择文件夹 文档' });
    const expandFolder = screen.getByRole('button', { name: '展开 文档' });

    expect(allFiles).toHaveAttribute('aria-pressed', 'true');
    expect(allFiles).toHaveClass('min-h-11');
    expect(rootFolder).toHaveClass('min-h-11');
    expect(selectFolder).toHaveClass('min-h-11');
    expect(expandFolder).toHaveAttribute('aria-expanded', 'false');
    expect(expandFolder).toHaveClass('min-h-11', 'min-w-11');

    selectFolder.focus();
    expect(document.activeElement).toBe(selectFolder);
    fireEvent.click(rootFolder);
    expect(onSelect).toHaveBeenCalledWith('root');

    fireEvent.click(expandFolder);
    expect(await screen.findByRole('button', { name: '选择文件夹 子文档' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '折叠 文档' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps row actions focusable and reveals them when the row receives keyboard focus', async () => {
    const { container } = render(<FolderTree selectedFolderId={null} onSelect={vi.fn()} refreshKey={0} />);
    const selectFolder = await screen.findByRole('button', { name: '选择文件夹 文档' });
    const row = selectFolder.parentElement;
    const actions = within(row as HTMLElement).getByRole('group', { name: '文档操作' });
    const rename = within(actions).getByRole('button', { name: '重命名 文档' });

    selectFolder.focus();
    expect(document.activeElement).toBe(selectFolder);
    expect(actions).toHaveClass('md:group-focus-within:flex');
    for (const button of within(actions).getAllByRole('button')) {
      expect(button).toHaveClass('min-h-11', 'min-w-11');
    }

    rename.focus();
    expect(document.activeElement).toBe(rename);
    expect(container.firstElementChild).toHaveClass('w-full', 'md:w-64');
  });
});
