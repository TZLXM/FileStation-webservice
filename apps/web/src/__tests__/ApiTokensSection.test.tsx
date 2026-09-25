// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { API_TOKEN_SCOPES, ApiTokenInfo, CreatedApiToken } from '@filestation/shared';
import ApiTokensSection from '../pages/settings/ApiTokensSection';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const issuedToken = 'synthetic-placeholder-only';
const activeToken: ApiTokenInfo = {
  id: 'token-1', name: 'desktop', token_prefix: 'fs_api_0123', scopes: ['files:read'],
  expires_at: null, created_at: '2026-09-25T00:00:00.000Z', last_used_at: null,
  last_used_ip: null, revoked_at: null,
};

describe('ApiTokensSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue({ data: [activeToken] } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('submits the API DTO, shows the issued plaintext once, and keeps it out of the list', async () => {
    const created: CreatedApiToken = { ...activeToken, id: 'token-2', token: issuedToken };
    mockedApi.post.mockResolvedValue({ data: created } as never);

    render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.change(screen.getByLabelText('Token 名称'), { target: { value: 'claude desktop' } });
    fireEvent.click(screen.getByLabelText('files:write'));
    fireEvent.change(screen.getByLabelText('有效期（天，留空永久）'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '签发 Token' }));

    expect(await screen.findByDisplayValue(issuedToken)).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenCalledWith('/api-tokens', {
      name: 'claude desktop', scopes: ['files:read', 'files:write'], expires_in_days: 30,
    });
    expect(screen.getByText('fs_api_0123…')).toBeInTheDocument();
    expect(screen.queryByText(issuedToken)).not.toBeInTheDocument();
    expect(localStorage.getItem('api-token')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '我已保存，关闭' }));
    expect(screen.queryByDisplayValue(issuedToken)).not.toBeInTheDocument();
    expect(screen.getByText('fs_api_0123…')).toBeInTheDocument();
  });

  it('does not restore plaintext after the component is unmounted and mounted again', async () => {
    mockedApi.post.mockResolvedValue({ data: { ...activeToken, token: issuedToken } } as never);
    const first = render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.change(screen.getByLabelText('Token 名称'), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByRole('button', { name: '签发 Token' }));
    await screen.findByDisplayValue(issuedToken);

    first.unmount();
    render(<ApiTokensSection />);

    await screen.findByText('desktop');
    expect(screen.queryByDisplayValue(issuedToken)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(issuedToken);
  });

  it('reports clipboard failures without an unhandled rejection', async () => {
    mockedApi.post.mockResolvedValue({ data: { ...activeToken, token: issuedToken } } as never);
    vi.stubGlobal('navigator', Object.create(window.navigator, {
      clipboard: { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } },
    }));
    render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.change(screen.getByLabelText('Token 名称'), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByRole('button', { name: '签发 Token' }));
    await screen.findByDisplayValue(issuedToken);

    fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
  });

  it('requires a valid name, at least one scope, and a valid optional lifetime', async () => {
    render(<ApiTokensSection />);
    const createButton = screen.getByRole('button', { name: '签发 Token' });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Token 名称'), { target: { value: 'valid name' } });
    fireEvent.click(screen.getByLabelText('files:read'));
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText('files:read'));
    fireEvent.change(screen.getByLabelText('有效期（天，留空永久）'), { target: { value: '366' } });
    expect(createButton).toBeDisabled();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it('offers exactly the scopes in the shared API contract', async () => {
    render(<ApiTokensSection />);
    await screen.findByText('desktop');

    expect(screen.getAllByRole('checkbox')).toHaveLength(API_TOKEN_SCOPES.length);
    for (const scope of API_TOKEN_SCOPES) {
      expect(screen.getByLabelText(scope)).toBeInTheDocument();
    }
  });

  it('does not treat an incomplete numeric lifetime as a permanent token', async () => {
    render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.change(screen.getByLabelText('Token 名称'), { target: { value: 'bounded token' } });
    fireEvent.change(screen.getByLabelText('有效期（天，留空永久）'), { target: { value: '1e' } });

    expect(screen.getByRole('button', { name: '签发 Token' })).toBeDisabled();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it('wraps an unbroken maximum-length token name within the list row', async () => {
    const longName = 'n'.repeat(64);
    mockedApi.get.mockResolvedValue({ data: [{ ...activeToken, name: longName }] } as never);
    render(<ApiTokensSection />);

    const nameElement = await screen.findByText(longName);
    expect(nameElement).toHaveClass('min-w-0', 'break-all');
    expect(nameElement.closest('li')).toHaveClass('min-w-0');
  });

  it('marks a token revoked only after the revoke succeeds and refreshes the list', async () => {
    mockedApi.get
      .mockResolvedValueOnce({ data: [activeToken] } as never)
      .mockResolvedValueOnce({ data: [{ ...activeToken, revoked_at: '2026-09-25T01:00:00.000Z' }] } as never);
    mockedApi.delete.mockResolvedValue({ data: null } as never);
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.click(screen.getByRole('button', { name: '吊销 desktop' }));

    expect(await screen.findByText('已吊销')).toBeInTheDocument();
    expect(mockedApi.delete).toHaveBeenCalledWith('/api-tokens/token-1');
    expect(mockedApi.get).toHaveBeenCalledTimes(2);
  });

  it('keeps an active token active and shows an error when revocation fails', async () => {
    mockedApi.delete.mockRejectedValue(new Error('server unavailable'));
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<ApiTokensSection />);
    await screen.findByText('desktop');
    fireEvent.click(screen.getByRole('button', { name: '吊销 desktop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('server unavailable');
    expect(screen.queryByText('已吊销')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '吊销 desktop' })).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledTimes(1);
  });
});
