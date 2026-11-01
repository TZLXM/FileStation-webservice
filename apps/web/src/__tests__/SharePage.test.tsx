// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SharePage from '../pages/SharePage';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({
      data: {
        id: 'share-1',
        file_id: 'file-1',
        filename: 'verylongfilenamewithoutanyspaces0123456789.zip',
        size: 1024,
        type: 'page',
        protection: 'none',
        requires_password: false,
        expires_at: null,
        max_downloads: null,
        used_downloads: 0,
      },
    })),
    post: vi.fn(async () => ({ data: { download_token: 'short-token' } })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    downloadFile: vi.fn(async () => undefined),
  },
}));

describe('SharePage mobile layout', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps the share card inset and wraps long filenames with a larger download target', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/s/share-1']}>
        <Routes><Route path="/s/:id" element={<SharePage />} /></Routes>
      </MemoryRouter>,
    );

    const heading = await screen.findByRole('heading', { name: 'verylongfilenamewithoutanyspaces0123456789.zip' });
    expect(container.firstElementChild).toHaveClass('px-4');
    expect(heading).toHaveClass('break-words', 'text-xl', 'md:text-2xl');
    expect(await screen.findByRole('button', { name: '下载文件' })).toHaveClass('py-3');
  });

  it('applies the deployment base to canonical download-ticket URLs', async () => {
    vi.stubEnv('BASE_URL', '/fs/');
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith('/download-ticket')) {
        return { data: { ticket_url: '/api/v1/downloads/ticket-1', expires_at: '2030-01-01T00:00:00.000Z' } } as never;
      }
      return { data: { download_token: 'short-token' } } as never;
    });
    let clickedHref: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.getAttribute('href');
    });

    render(
      <MemoryRouter initialEntries={['/s/share-1']}>
        <Routes><Route path="/s/:id" element={<SharePage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '下载文件' }));

    await waitFor(() => expect(clickedHref).toBe('/fs/api/v1/downloads/ticket-1'));
  });
});
