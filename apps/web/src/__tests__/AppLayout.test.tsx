// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../App';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === '/folders/tree') return { data: [] };
      if (path === '/settings') {
        return {
          data: {
            site: { name: 'FileStation', icon: null, theme_color: '#2563eb' },
            security: { totp_required: false, max_login_attempts: 5, lockout_minutes: 15 },
            transfer: { default_chunk_size: 4194304, global_upload_limit_bps: null, global_download_limit_bps: null },
            storage: { path: '/data', max_size_gb: 100, cleanup_grace_hours: 24, default_expire_hours: 168 },
            agent: { mcp_enabled: false, mcp_max_upload_mb: 32 },
          },
        };
      }
      if (path === '/api-tokens') return { data: [] };
      return { data: { items: [], total: 0, page: 1, page_size: 20, total_pages: 0 } };
    }),
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

describe('global navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(min-width: 768px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)));
    useAuthStore.setState({
      isAuthenticated: true,
      accessToken: 'test-token',
      username: 'alice',
      logout: async () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows files and settings navigation, hides the username below the small breakpoint, and shows the files drawer control', async () => {
    render(<App />);

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '文件' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByText('alice')).toHaveClass('hidden', 'sm:inline');
    expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveClass('md:hidden');

    fireEvent.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
  });

  it('takes the user to login even when the logout promise rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useAuthStore.setState({ logout: vi.fn().mockRejectedValue(new Error('offline')) });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(mockedApi.get).not.toHaveBeenCalledWith('/settings');
  });

  it('opens the protected audit route and marks its navigation item active', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '审计' }));

    expect(await screen.findByRole('heading', { name: '审计日志' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '审计' })).toHaveAttribute('aria-current', 'page');
    expect(mockedApi.get).toHaveBeenCalledWith('/audit-logs?page=1&page_size=20');
  });

  it('requires authentication before loading the audit route', async () => {
    window.history.replaceState({}, '', '/audit');
    useAuthStore.setState({ isAuthenticated: false, accessToken: null, username: null });
    mockedApi.post.mockRejectedValueOnce(new Error('no session'));

    render(<App />);

    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(mockedApi.get).not.toHaveBeenCalledWith(expect.stringContaining('/audit-logs'));
  });
});
