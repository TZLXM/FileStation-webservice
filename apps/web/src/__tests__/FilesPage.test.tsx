// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FilesPage from '../pages/FilesPage';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => path === '/folders/tree'
      ? { data: [{ id: 'folder-1', name: '文档', parent_id: null, children: [] }] }
      : { data: { items: [], total: 0, page: 1, page_size: 20, total_pages: 0 } }),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    downloadFile: vi.fn(async () => undefined),
  },
}));

vi.mock('../components/FileUpload', () => ({ default: () => <div>上传文件</div> }));
vi.mock('../components/FileList', () => ({ default: () => <div>文件列表</div> }));

const mockedApi = vi.mocked(api);

function createMediaQueryHarness() {
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  const addEventListener = vi.fn((_type: string, handler: (event: MediaQueryListEvent) => void) => {
    listener = handler;
  });
  const removeEventListener = vi.fn((_type: string, handler: (event: MediaQueryListEvent) => void) => {
    if (listener === handler) listener = null;
  });
  const mediaQueryList = {
    matches: false,
    media: '(min-width: 768px)',
    onchange: null,
    addEventListener,
    removeEventListener,
  } as unknown as MediaQueryList;

  return {
    mediaQueryList,
    addEventListener,
    removeEventListener,
    matchMedia: vi.fn((_query: string) => mediaQueryList),
    emitChange(matches: boolean) {
      listener?.({ matches, media: mediaQueryList.media } as MediaQueryListEvent);
    },
  };
}

let mediaQueryHarness: ReturnType<typeof createMediaQueryHarness>;

describe('FilesPage folder drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.style.overflow = 'auto';
    mediaQueryHarness = createMediaQueryHarness();
    vi.stubGlobal('matchMedia', mediaQueryHarness.matchMedia);
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'test-token', username: 'alice' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.style.overflow = '';
  });

  it('opens as a dialog, closes from the backdrop, and restores body scroll and focus', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    const openButton = screen.getByRole('button', { name: '打开文件夹' });

    openButton.focus();
    fireEvent.click(openButton);

    const drawer = screen.getByRole('dialog', { name: '文件夹' });
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(drawer);
    fireEvent.click(screen.getByTestId('folder-drawer-backdrop'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '文件夹' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('auto');
    expect(document.activeElement).toBe(openButton);
  });

  it('closes the drawer after selecting a folder and loads that folder', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));

    const drawer = screen.getByRole('dialog', { name: '文件夹' });
    fireEvent.click(await within(drawer).findByText('文档'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '文件夹' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('auto');
    expect(mockedApi.get).toHaveBeenCalledWith('/files?page=1&page_size=20&folder_id=folder-1');
  });

  it('restores body scroll when unmounted with the drawer open', async () => {
    const { unmount } = render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('auto');
  });

  it('closes the drawer with Escape', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    const openButton = screen.getByRole('button', { name: '打开文件夹' });
    openButton.focus();
    fireEvent.click(openButton);
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '文件夹' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(openButton);
  });

  it('cycles forward and backward Tab focus within the drawer', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));

    const drawer = screen.getByRole('dialog', { name: '文件夹' });
    const buttons = within(drawer).getAllByRole('button');
    const firstButton = buttons[0];
    const lastButton = buttons[buttons.length - 1];

    firstButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastButton);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstButton);
  });

  it('returns Tab focus to the drawer when focus is outside the modal', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    const openButton = screen.getByRole('button', { name: '打开文件夹' });
    fireEvent.click(openButton);

    const drawer = screen.getByRole('dialog', { name: '文件夹' });
    const firstButton = within(drawer).getAllByRole('button')[0];
    openButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(firstButton);
  });

  it('closes and unlocks body scrolling when the viewport enters desktop width', async () => {
    render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));
    const drawer = screen.getByRole('dialog', { name: '文件夹' });
    const closeButton = within(drawer).getByRole('button', { name: '关闭文件夹' });
    closeButton.focus();
    expect(document.body.style.overflow).toBe('hidden');

    mediaQueryHarness.emitChange(true);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '文件夹' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('auto');
    expect(document.activeElement).not.toBe(closeButton);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '打开文件夹' }));
  });

  it('removes the desktop breakpoint listener on unmount', async () => {
    const { unmount } = render(<MemoryRouter><FilesPage /></MemoryRouter>);
    await screen.findAllByText('文档');
    expect(mediaQueryHarness.matchMedia).toHaveBeenCalledWith('(min-width: 768px)');
    expect(mediaQueryHarness.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    const listener = mediaQueryHarness.addEventListener.mock.calls[0][1];

    unmount();

    expect(mediaQueryHarness.removeEventListener).toHaveBeenCalledWith('change', listener);
  });
});
