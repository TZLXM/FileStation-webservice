// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const baseSettings = {
  site: { name: 'FileStation', icon: null, theme_color: '#2563eb' },
  security: { totp_required: false, max_login_attempts: 5, lockout_minutes: 15 },
  transfer: { default_chunk_size: 4194304, global_upload_limit_bps: null, global_download_limit_bps: null },
  storage: { path: '/data', max_size_gb: 100, cleanup_grace_hours: 24, default_expire_hours: 168 },
};

describe('SettingsPage Phase 2 sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'test-token', username: 'alice' });
  });

  afterEach(cleanup);

  it('mounts token and agent sections, refreshes agent props, and preserves unrelated drafts', async () => {
    let savedAgent = { mcp_enabled: false, mcp_max_upload_mb: 32 };
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === '/settings') return { data: { ...baseSettings, agent: savedAgent } } as never;
      if (path === '/api-tokens') return { data: [] } as never;
      return { data: [] } as never;
    });
    mockedApi.put.mockImplementation(async (_path: string, body?: BodyInit | object) => {
      savedAgent = (body as { agent: typeof savedAgent }).agent;
      return { data: {} } as never;
    });

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'API Token' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent 接入（MCP）' })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('FileStation'), { target: { value: 'Draft site name' } });
    fireEvent.click(screen.getByLabelText('启用 MCP 端点'));
    fireEvent.change(screen.getByLabelText('MCP 单文件大小上限（MB）'), { target: { value: '64' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }));

    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith('/settings'));
    await waitFor(() => expect(screen.getByLabelText('启用 MCP 端点')).toBeChecked());
    expect(screen.getByLabelText('MCP 单文件大小上限（MB）')).toHaveValue(64);
    expect(screen.getByDisplayValue('Draft site name')).toBeInTheDocument();
  });
});
