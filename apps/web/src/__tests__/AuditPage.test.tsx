// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditLogEntry, PaginatedResponse } from '@filestation/shared';
import AuditPage from '../pages/AuditPage';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const log = (id: string, action: string): AuditLogEntry => ({
  id, account_id: 'admin-1', action, resource_type: 'file', resource_id: `resource-${id}`,
  details: { filename: 'a-very-long-filename-that-remains-readable.zip' }, ip_address: '192.168.1.0',
  user_agent: 'test', created_at: '2026-09-25T00:00:00.000Z',
});
const result = (items: AuditLogEntry[], total: number, page = 1): PaginatedResponse<AuditLogEntry> => ({
  items, total, page, page_size: 20, total_pages: Math.ceil(total / 20),
});

describe('AuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue({ data: result([log('1', 'auth.login')], 1) } as never);
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'test-token', username: 'alice' });
  });

  afterEach(() => cleanup());

  it('loads audit entries, applies the action filter, and navigates pages', async () => {
    mockedApi.get
      .mockResolvedValueOnce({ data: result([log('1', 'auth.login')], 41) } as never)
      .mockResolvedValueOnce({ data: result([log('2', 'mcp.tool_called')], 41, 2) } as never);
    render(<MemoryRouter><AuditPage /></MemoryRouter>);
    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(screen.getByText('共 41 条')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('按操作过滤'), { target: { value: 'mcp.tool_called' } });
    expect(await screen.findByText('mcp.tool_called')).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenLastCalledWith('/audit-logs?page=1&page_size=20&action=mcp.tool_called');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(mockedApi.get).toHaveBeenLastCalledWith('/audit-logs?page=2&page_size=20&action=mcp.tool_called'));
  });

  it('ignores a slow response after a newer filter request has completed', async () => {
    let resolveFirst!: (response: unknown) => void;
    mockedApi.get
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }) as never)
      .mockResolvedValueOnce({ data: result([log('new', 'mcp.new')], 1) } as never);
    render(<MemoryRouter><AuditPage /></MemoryRouter>);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('按操作过滤'), { target: { value: 'mcp' } });
    expect(await screen.findByText('mcp.new')).toBeInTheDocument();
    resolveFirst({ data: result([log('old', 'auth.stale')], 1) });

    await waitFor(() => expect(screen.queryByText('auth.stale')).not.toBeInTheDocument());
    expect(screen.getByText('mcp.new')).toBeInTheDocument();
  });

  it('shows request errors and a distinct empty state instead of swallowing failures', async () => {
    mockedApi.get
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce({ data: result([], 0) } as never);
    render(<MemoryRouter><AuditPage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('audit unavailable');
    fireEvent.change(screen.getByLabelText('按操作过滤'), { target: { value: 'missing' } });
    expect(await screen.findByText('暂无审计记录')).toBeInTheDocument();
  });

  it('keeps wide tables in a local scroll region and exposes full details on demand', async () => {
    render(<MemoryRouter><AuditPage /></MemoryRouter>);

    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(screen.getByTestId('audit-table-scroll')).toHaveClass('overflow-x-auto');
    const details = screen.getByText('查看完整详情');
    fireEvent.click(details);
    expect(details.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/a-very-long-filename-that-remains-readable\.zip/)).toBeInTheDocument();
  });
});
