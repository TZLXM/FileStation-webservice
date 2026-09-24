// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FolderNode } from '@filestation/shared';
import FolderTree from '../components/FolderTree';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: [{ id: 'folder-1', name: '文档', parent_id: null, children: [] }] })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    downloadFile: vi.fn(async () => undefined),
  },
}));

const folders: FolderNode[] = [{ id: 'folder-1', name: '文档', parent_id: null, children: [] }];

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
});
