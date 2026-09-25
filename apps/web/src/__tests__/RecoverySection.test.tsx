// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RecoverySection from '../pages/settings/RecoverySection';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const recoveryCodes = [
  'ABCD-EFGH-JK', 'BCDE-FGHJ-KM', 'CDEF-GHJK-MN', 'DEFG-HJKM-NP', 'EFGH-JKMN-PQ',
  'FGHJ-KMNP-QR', 'GHJK-MNPQ-RS', 'HJKM-NPQR-ST', 'JKMN-PQRS-TV', 'KMNP-QRST-VW',
];

describe('RecoverySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the password and required TOTP, then displays the one-time response only in memory', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<RecoverySection totpActive />);

    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前 6 位 TOTP 验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));

    expect(mockedApi.post).toHaveBeenCalledWith('/auth/recovery/generate', {
      password: 'password-placeholder', totp_code: '123456',
    });
    expect(await screen.findByText(recoveryCodes[0])).toBeInTheDocument();
    for (const code of recoveryCodes) expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('只会展示一次');
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '我已安全保存，关闭' }));
    expect(screen.queryByText(recoveryCodes[0])).not.toBeInTheDocument();
    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
    setItem.mockRestore();
  });

  it('omits TOTP when disabled and clears credentials after a failed generation attempt', async () => {
    mockedApi.post.mockRejectedValue(new Error('generation rejected'));
    render(<RecoverySection totpActive={false} />);

    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    expect(screen.queryByLabelText('当前 6 位 TOTP 验证码')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('generation rejected');
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/recovery/generate', {
      password: 'password-placeholder',
    });
  });

  it('requires a six-digit TOTP before issuing recovery codes', async () => {
    render(<RecoverySection totpActive />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.change(screen.getByLabelText('当前 6 位 TOTP 验证码'), { target: { value: '123' } });

    expect(screen.getByRole('button', { name: '确认生成' })).toBeDisabled();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it('prevents duplicate generation submissions while the first request is pending', async () => {
    let resolveGeneration!: (response: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolveGeneration = resolve; }) as never);
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    const form = screen.getByRole('button', { name: '确认生成' }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(mockedApi.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(recoveryCodes[0])).not.toBeInTheDocument();
    await act(async () => resolveGeneration({ data: { codes: recoveryCodes } }));
    expect(await screen.findByText(recoveryCodes[0])).toBeInTheDocument();
  });

  it('ignores a cancelled stale response without unlocking a newer generation request', async () => {
    let resolveFirst!: (response: unknown) => void;
    let resolveSecond!: (response: unknown) => void;
    mockedApi.post
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }) as never);
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'first-password-placeholder' } });
    const firstForm = screen.getByRole('button', { name: '确认生成' }).closest('form')!;
    fireEvent.submit(firstForm);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'second-password-placeholder' } });
    const secondForm = screen.getByRole('button', { name: '确认生成' }).closest('form')!;
    fireEvent.submit(secondForm);
    expect(mockedApi.post).toHaveBeenCalledTimes(2);

    await act(async () => resolveFirst({ data: { codes: ['STALE-CODE'] } }));
    expect(screen.getByRole('button', { name: '正在生成…' })).toBeDisabled();
    expect(screen.queryByText('STALE-CODE')).not.toBeInTheDocument();
    await act(async () => resolveSecond({ data: { codes: recoveryCodes } }));
    expect(await screen.findByText(recoveryCodes[0])).toBeInTheDocument();
  });

  it('does not publish codes when generation resolves after the section unmounts', async () => {
    let resolveGeneration!: (response: unknown) => void;
    mockedApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolveGeneration = resolve; }) as never);
    const first = render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    first.unmount();

    await act(async () => resolveGeneration({ data: { codes: recoveryCodes } }));
    render(<RecoverySection totpActive={false} />);
    expect(screen.queryByText(recoveryCodes[0])).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it('copies the complete group and announces clipboard success or failure', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', Object.create(window.navigator, {
      clipboard: { configurable: true, value: { writeText } },
    }));
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    fireEvent.click(screen.getByRole('button', { name: '复制全部' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(recoveryCodes.join('\n')));
    expect(screen.getByRole('status')).toHaveTextContent('已复制');

    writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    fireEvent.click(screen.getByRole('button', { name: '复制全部' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
  });

  it('ignores a late clipboard result after the user clears the one-time group', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    let resolveCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    vi.stubGlobal('navigator', Object.create(window.navigator, {
      clipboard: { configurable: true, value: { writeText } },
    }));
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);
    fireEvent.click(screen.getByRole('button', { name: '复制全部' }));
    fireEvent.click(screen.getByRole('button', { name: '我已安全保存，关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));

    await act(async () => resolveCopy());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('当前密码')).toBeInTheDocument();
  });

  it('downloads a text file, reports success, and revokes its object URL', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    let downloadedBlob: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return 'blob:recovery-codes-placeholder';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL } as unknown as typeof URL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('filestation-recovery-codes.txt');
      expect(this.href).toBe('blob:recovery-codes-placeholder');
      expect(this.isConnected).toBe(true);
    });
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    fireEvent.click(screen.getByRole('button', { name: '下载恢复码' }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = downloadedBlob!;
    expect(blob.type).toBe('text/plain;charset=utf-8');
    const contents = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(contents).toBe(`${recoveryCodes.join('\n')}\n`);
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-codes-placeholder'));
    expect(screen.getByRole('status')).toHaveTextContent('恢复码文件已开始下载');
  });

  it('reports download failures from Blob construction and object URL creation', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:recovery-codes-placeholder');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL } as unknown as typeof URL);
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    vi.stubGlobal('Blob', class { constructor() { throw new Error('Blob unavailable'); } } as unknown as typeof Blob);
    fireEvent.click(screen.getByRole('button', { name: '下载恢复码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('下载失败');
    expect(createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const failingUrl = vi.fn((_blob: Blob) => { throw new Error('object URL unavailable'); });
    vi.stubGlobal('URL', { createObjectURL: failingUrl, revokeObjectURL } as unknown as typeof URL);
    fireEvent.click(screen.getByRole('button', { name: '下载恢复码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('下载失败');
    expect(failingUrl).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL and reports link-click failures', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:recovery-codes-placeholder');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL } as unknown as typeof URL);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download denied');
    });
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    fireEvent.click(screen.getByRole('button', { name: '下载恢复码' }));

    expect(screen.getByRole('alert')).toHaveTextContent('下载失败');
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-codes-placeholder'));
    expect(document.querySelector('a[download="filestation-recovery-codes.txt"]')).not.toBeInTheDocument();
  });

  it('reports a failure to revoke the temporary object URL after starting the download', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:recovery-codes-placeholder');
    const revokeObjectURL = vi.fn(() => { throw new Error('revoke denied'); });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL } as unknown as typeof URL);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    fireEvent.click(screen.getByRole('button', { name: '下载恢复码' }));

    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-codes-placeholder');
      expect(screen.getByRole('alert')).toHaveTextContent('未能释放临时下载链接');
    });
  });

  it('clears the password on cancel and does not restore codes after unmount', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    const first = render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    first.unmount();
    render(<RecoverySection totpActive={false} />);
    expect(screen.queryByText(recoveryCodes[0])).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(recoveryCodes[0]);
  });

  it('keeps recovery codes and actions within a narrow responsive layout contract', async () => {
    mockedApi.post.mockResolvedValue({ data: { codes: recoveryCodes } } as never);
    render(<RecoverySection totpActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '生成新的一组' }));
    expect(screen.getByLabelText('当前密码')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('当前密码')).toHaveClass('min-w-0', 'w-full');
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'password-placeholder' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    await screen.findByText(recoveryCodes[0]);

    const list = screen.getByRole('list', { name: '一次性恢复码' });
    expect(list).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'min-w-0');
    expect(screen.getByText(recoveryCodes[0])).toHaveClass('min-w-0', 'break-all');
    expect(screen.getByText(recoveryCodes[0]).closest('li')).toHaveClass('min-w-0');
    expect(screen.getByRole('button', { name: '复制全部' }).parentElement).toHaveClass('flex-col', 'sm:flex-row');
  });
});
