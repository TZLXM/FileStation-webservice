// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AgentSection from '../pages/settings/AgentSection';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const initialAgent = { mcp_enabled: false, mcp_max_upload_mb: 32 };

describe('AgentSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.put.mockResolvedValue({ data: {} } as never);
  });

  afterEach(cleanup);

  it('saves the MCP settings using the server DTO limits and refreshes its parent', async () => {
    const onSaved = vi.fn();
    render(<AgentSection agent={initialAgent} onSaved={onSaved} />);
    fireEvent.click(screen.getByLabelText('启用 MCP 端点'));
    fireEvent.change(screen.getByLabelText('MCP 单文件大小上限（MB）'), { target: { value: '512' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }));

    expect(await screen.findByRole('status')).toHaveTextContent('已保存');
    expect(mockedApi.put).toHaveBeenCalledWith('/settings', {
      agent: { mcp_enabled: true, mcp_max_upload_mb: 512 },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('synchronizes controlled inputs when refreshed settings props change', () => {
    const { rerender } = render(<AgentSection agent={initialAgent} onSaved={vi.fn()} />);
    rerender(<AgentSection agent={{ mcp_enabled: true, mcp_max_upload_mb: 64 }} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('启用 MCP 端点')).toBeChecked();
    expect(screen.getByLabelText('MCP 单文件大小上限（MB）')).toHaveValue(64);
  });

  it('rejects values outside the server range and presents save errors', async () => {
    render(<AgentSection agent={initialAgent} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('MCP 单文件大小上限（MB）'), { target: { value: '513' } });
    expect(screen.getByRole('button', { name: '保存 MCP 设置' })).toBeDisabled();
    expect(mockedApi.put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('MCP 单文件大小上限（MB）'), { target: { value: '33' } });
    mockedApi.put.mockRejectedValueOnce(new Error('settings rejected'));
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('settings rejected');
    expect(screen.getByLabelText('MCP 单文件大小上限（MB）')).toHaveValue(33);
  });
});
