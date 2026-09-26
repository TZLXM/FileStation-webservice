// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import FileUpload from '../components/FileUpload';
import { ApiError, api, type UploadApiStatus } from '../lib/api';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

const mockedApi = vi.mocked(api);
const pendingUpload = {
  upload_id: 'upload-1',
  upload_token: 'resume-secret-token',
  chunk_size: 4,
  filename: 'payload.bin',
  size: 8,
  folder_id: null,
  saved_at: Date.now(),
};

function activeStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: pendingUpload.upload_id,
    status: 'uploading',
    received_parts: [0],
    received_size: 4,
    total_parts: 2,
    expected_size: 8,
    ...overrides,
  };
}

function apiFailure(status: number, code?: string, currentStatus?: string) {
  return new ApiError(status, 'server response contains resume-secret-token', code, currentStatus as UploadApiStatus | undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeFile(name: string, size: number): File {
  const bytes = new Uint8Array(size).fill(0x41);
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  Object.defineProperty(file, 'slice', {
    value: (start = 0, end = size) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
  });
  return file;
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected a file input');
  return input;
}

function seedPending() {
  localStorage.setItem(`fs_upload_${pendingUpload.upload_id}`, JSON.stringify(pendingUpload));
}

function mockCryptoDigest() {
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } });
}

describe('FileUpload resume UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockedApi.get.mockResolvedValue({ data: [] } as never);
    mockedApi.post.mockResolvedValue({ data: {} } as never);
    mockedApi.put.mockResolvedValue({ data: {} } as never);
    mockedApi.delete.mockResolvedValue({ data: {} } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('probes a saved upload with its token and shows confirmed active progress', async () => {
    localStorage.setItem(`fs_upload_${pendingUpload.upload_id}`, JSON.stringify(pendingUpload));
    mockedApi.get.mockResolvedValue({ data: {
      id: pendingUpload.upload_id,
      status: 'uploading',
      received_parts: [0],
      received_size: 4,
      total_parts: 2,
      expected_size: 8,
    } } as never);

    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}`,
      { 'X-Upload-Token': pendingUpload.upload_token },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText('payload.bin')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: '待续传上传' });
    const row = within(region).getByText('payload.bin').closest('li');
    expect(row).toHaveClass('flex-col', 'sm:flex-row');
    expect(within(region).getByRole('progressbar', { name: 'payload.bin 上传进度' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '继续上传 payload.bin' })).toHaveClass('min-h-10');
    expect(within(region).getByRole('button', { name: '放弃上传 payload.bin' })).toHaveClass('min-h-10');
  });

  it.each([404, 410])('removes a saved upload only after a definite HTTP %i probe result', async (status) => {
    seedPending();
    mockedApi.get.mockRejectedValue(apiFailure(status));

    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    await waitFor(() => expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).toBeNull());
    expect(screen.queryByText('payload.bin')).not.toBeInTheDocument();
  });

  it('keeps network and server failures visible with a retry action', async () => {
    seedPending();
    mockedApi.get
      .mockRejectedValueOnce(apiFailure(503))
      .mockResolvedValueOnce({ data: activeStatus() } as never);

    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    expect(await screen.findByText(/暂时无法确认上传状态/)).toBeInTheDocument();
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /重试检查/ }));

    expect(await screen.findByRole('button', { name: /继续上传/ })).toBeInTheDocument();
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
  });

  it.each(['completed', 'aborted', 'failed', 'expired'])('removes a server-confirmed %s upload', async (status) => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus({ status }) } as never);

    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    await waitFor(() => expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).toBeNull());
  });

  it('isolates a late 404 probe after StrictMode unmount so it cannot erase saved state', async () => {
    seedPending();
    const requests: Array<ReturnType<typeof deferred<never>>> = [];
    mockedApi.get.mockImplementation(() => {
      const request = deferred<never>();
      requests.push(request);
      return request.promise as never;
    });
    const { unmount } = render(<StrictMode><FileUpload onUploadComplete={vi.fn()} folderId={null} /></StrictMode>);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    unmount();
    await act(async () => requests.forEach((request) => request.reject(apiFailure(404))));

    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
  });

  it('ignores a stale StrictMode probe after the remounted probe confirms the upload is active', async () => {
    const entry = { ...pendingUpload, upload_id: 'strict-upload', upload_token: 'strict-token', filename: 'strict.bin' };
    localStorage.setItem(`fs_upload_${entry.upload_id}`, JSON.stringify(entry));
    const requests: Array<ReturnType<typeof deferred<never>>> = [];
    mockedApi.get.mockImplementation(() => {
      const request = deferred<never>();
      requests.push(request);
      return request.promise as never;
    });
    render(<StrictMode><FileUpload onUploadComplete={vi.fn()} folderId={null} /></StrictMode>);
    await waitFor(() => expect(requests).toHaveLength(2));

    await act(async () => requests[1].resolve({ data: {
      ...activeStatus({ id: entry.upload_id, expected_size: entry.size }),
    } } as never));
    expect(await screen.findByRole('button', { name: '继续上传 strict.bin' })).toBeEnabled();

    await act(async () => requests[0].reject(apiFailure(404)));

    expect(localStorage.getItem(`fs_upload_${entry.upload_id}`)).not.toBeNull();
    expect(screen.getByRole('button', { name: '继续上传 strict.bin' })).toBeEnabled();
  });

  it('uploads a new file, stores the resume secret, and removes it only after complete succeeds', async () => {
    mockCryptoDigest();
    const onUploadComplete = vi.fn();
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        upload_id: 'new-upload', upload_token: 'new-resume-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
      } } as never)
      .mockResolvedValueOnce({ data: { file_id: 'file-1' } } as never);
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId="folder-1" />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.bin', 8)] } });

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mockedApi.post).toHaveBeenNthCalledWith(1, '/uploads', { filename: 'new.bin', size: 8, folder_id: 'folder-1' }, undefined, expect.any(AbortSignal));
    expect(mockedApi.put).toHaveBeenCalledTimes(2);
    expect(mockedApi.post).toHaveBeenNthCalledWith(2, '/uploads/new-upload/complete', {}, { 'X-Upload-Token': 'new-resume-token' }, expect.any(AbortSignal));
    expect(localStorage.getItem('fs_upload_new-upload')).toBeNull();
  });

  it('sends the exact SHA-256 checksum over LAN HTTP when SubtleCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', { subtle: undefined });
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        upload_id: 'lan-upload', upload_token: 'lan-resume-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
      } } as never)
      .mockResolvedValueOnce({ data: { file_id: 'file-1' } } as never);
    const onUploadComplete = vi.fn();
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('lan.bin', 4)] } });

    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledWith(
      '/uploads/lan-upload/parts/0',
      expect.anything(),
      {
        'X-Upload-Token': 'lan-resume-token',
        'X-Part-Checksum': '63c1dd951ffedf6f7fd968ad4efa39b8ed584f162f46e715114ee184f8de9201',
      },
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
  });

  it('shows a checksum-specific error and retains a new pending upload when hashing fails', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('digest unavailable')) } });
    mockedApi.post.mockResolvedValueOnce({ data: {
      upload_id: 'hash-failure-upload', upload_token: 'hash-failure-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
    } } as never);
    const invalidBuffer = Object.defineProperty({}, 'length', {
      get() { throw new Error('invalid buffer source'); },
    }) as unknown as ArrayBuffer;
    const bytes = new Uint8Array(4).fill(0x41);
    const file = new File([bytes], 'hash-failure.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
    Object.defineProperty(file, 'slice', {
      value: (start = 0, end = 4) => ({ arrayBuffer: async () => invalidBuffer, size: end - start }),
    });
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [file] } });

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith('/uploads', expect.anything(), undefined, expect.any(AbortSignal)));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法计算分块 SHA-256 校验值');
    expect(localStorage.getItem('fs_upload_hash-failure-upload')).not.toBeNull();
    expect(mockedApi.put).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('hash-failure-token');
  });

  it('keeps new-upload initialization single-flight across repeated file selections', async () => {
    const initRequest = deferred<never>();
    const onUploadComplete = vi.fn();
    mockedApi.post
      .mockReturnValueOnce(initRequest.promise as never)
      .mockResolvedValueOnce({ data: { file_id: 'empty-file' } } as never);
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);
    const input = fileInput(container);
    const emptyFile = makeFile('empty.bin', 0);

    fireEvent.change(input, { target: { files: [emptyFile] } });
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith('/uploads', expect.anything(), undefined, expect.any(AbortSignal)));
    fireEvent.change(input, { target: { files: [emptyFile] } });
    expect(mockedApi.post.mock.calls.filter(([path]) => path === '/uploads')).toHaveLength(1);

    await act(async () => initRequest.resolve({ data: {
      upload_id: 'empty-upload', upload_token: 'empty-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
    } } as never));
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
  });

  it('aborts an unmounted uploader, stops its old chunk loop, and reloads state from the server probe', async () => {
    mockCryptoDigest();
    mockedApi.post.mockResolvedValueOnce({ data: {
      upload_id: 'new-upload', upload_token: 'new-resume-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
    } } as never);
    const firstPart = deferred<never>();
    mockedApi.put.mockReturnValueOnce(firstPart.promise as never);
    const firstMount = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.change(fileInput(firstMount.container), { target: { files: [makeFile('large.bin', 12)] } });
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledTimes(1));
    const partSignal = mockedApi.put.mock.calls[0]?.[3] as AbortSignal | undefined;

    firstMount.unmount();
    await act(async () => {
      firstPart.resolve({} as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(partSignal).toBeInstanceOf(AbortSignal);
    expect(partSignal?.aborted).toBe(true);
    expect(mockedApi.put).toHaveBeenCalledTimes(1);
    expect(mockedApi.post.mock.calls.filter(([path]) => path === '/uploads/new-upload/complete')).toHaveLength(0);
    expect(localStorage.getItem('fs_upload_new-upload')).not.toBeNull();

    mockedApi.get.mockResolvedValueOnce({ data: activeStatus({
      id: 'new-upload',
      expected_size: 12,
      received_parts: [0],
      received_size: 4,
      total_parts: 3,
    }) } as never);
    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    expect(await screen.findByRole('button', { name: '继续上传 large.bin' })).toBeEnabled();
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(mockedApi.post.mock.calls.filter(([path]) => path === '/uploads/new-upload/resume')).toHaveLength(0);
  });

  it('keeps resume state when every part uploads but complete fails', async () => {
    mockCryptoDigest();
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        upload_id: 'new-upload', upload_token: 'new-resume-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
      } } as never)
      .mockRejectedValueOnce(apiFailure(503));
    const onUploadComplete = vi.fn();
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.bin', 4)] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('续传状态已保留');
    expect(onUploadComplete).not.toHaveBeenCalled();
    expect(localStorage.getItem('fs_upload_new-upload')).not.toBeNull();
  });

  it('continues uploading when localStorage rejects a write and clearly warns recovery was not saved', async () => {
    mockCryptoDigest();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const onUploadComplete = vi.fn();
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        upload_id: 'new-upload', upload_token: 'new-resume-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
      } } as never)
      .mockResolvedValueOnce({ data: { file_id: 'file-1' } } as never);
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.bin', 4)] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存续传状态');
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mockedApi.put).toHaveBeenCalledTimes(1);
  });

  it('preserves a pending record after an interrupted part request without showing the token', async () => {
    mockCryptoDigest();
    const token = 'secret-never-render-this';
    mockedApi.post.mockResolvedValueOnce({ data: {
      upload_id: 'new-upload', upload_token: token, chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
    } } as never);
    mockedApi.put.mockRejectedValueOnce(apiFailure(503));
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.bin', 4)] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('续传状态已保留');
    expect(localStorage.getItem('fs_upload_new-upload')).not.toBeNull();
    expect(document.body.textContent).not.toContain(token);
  });

  it('requires matching filename and size before contacting the resume endpoint', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /继续上传/ }));
    fireEvent.change(screen.getByLabelText('选择待恢复文件'), { target: { files: [makeFile('different.bin', 8)] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('所选文件与待恢复上传不匹配');
    expect(mockedApi.post).not.toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}/resume`,
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
    expect(container.textContent).not.toContain(pendingUpload.upload_token);
  });

  it('retains the record and rejects malformed or duplicate server part numbers before sending chunks', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    mockedApi.post.mockResolvedValueOnce({ data: { received_parts: [0, 0], chunk_size: 4 } } as never);
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /继续上传/ }));
    fireEvent.change(screen.getByLabelText('选择待恢复文件'), { target: { files: [makeFile('payload.bin', 8)] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('服务器返回的续传分块状态无效');
    expect(mockedApi.put).not.toHaveBeenCalled();
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
    expect(container.textContent).not.toContain(pendingUpload.upload_token);
  });

  it('uses server resume parts, skips received chunks, and reports finite upload progress', async () => {
    mockCryptoDigest();
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    mockedApi.post.mockResolvedValueOnce({ data: { received_parts: [0], chunk_size: 4 } } as never);
    const partRequest = deferred<never>();
    mockedApi.put.mockReturnValueOnce(partRequest.promise as never);
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /继续上传/ }));
    const resumeInput = screen.getByLabelText('选择待恢复文件');
    fireEvent.change(resumeInput, { target: { files: [makeFile('payload.bin', 8)] } });

    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledTimes(1));
    expect(mockedApi.post).toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}/resume`,
      undefined,
      { 'X-Upload-Token': pendingUpload.upload_token },
      expect.any(AbortSignal),
    );
    expect(mockedApi.put).toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}/parts/1`,
      expect.anything(),
      { 'X-Upload-Token': pendingUpload.upload_token, 'X-Part-Checksum': '0'.repeat(64) },
      expect.any(AbortSignal),
    );
    expect(screen.getAllByRole('progressbar', { name: 'payload.bin 上传进度' })).toHaveLength(2);
    expect(screen.getAllByRole('progressbar', { name: 'payload.bin 上传进度' }).every((progressbar) => (
      progressbar.getAttribute('value') === '50'
    ))).toBe(true);
    expect(container.textContent).not.toContain('无法保存续传状态');
    const storedAfterResume = JSON.parse(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`) ?? 'null');
    expect(storedAfterResume).toMatchObject({ upload_id: pendingUpload.upload_id, chunk_size: 4 });
    expect(storedAfterResume).not.toHaveProperty('received_parts');
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    fireEvent.change(resumeInput, { target: { files: [makeFile('payload.bin', 8)] } });
    expect(mockedApi.post.mock.calls.filter(([path]) => path === `/uploads/${pendingUpload.upload_id}/resume`)).toHaveLength(1);

    await act(async () => partRequest.resolve({} as never));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}/complete`,
      {},
      { 'X-Upload-Token': pendingUpload.upload_token },
      expect.any(AbortSignal),
    ));
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).toBeNull();
  });

  it('completes a zero-byte new upload without trying to upload a nonexistent chunk', async () => {
    const completeRequest = deferred<never>();
    mockedApi.post
      .mockResolvedValueOnce({ data: {
        upload_id: 'empty-upload', upload_token: 'empty-token', chunk_size: 4, expires_at: '2030-01-01T00:00:00.000Z',
      } } as never)
      .mockReturnValueOnce(completeRequest.promise as never);
    const onUploadComplete = vi.fn();
    const { container } = render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('empty.bin', 0)] } });

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith(
      '/uploads/empty-upload/complete',
      {},
      { 'X-Upload-Token': 'empty-token' },
      expect.any(AbortSignal),
    ));
    expect(mockedApi.put).not.toHaveBeenCalled();
    expect(screen.getAllByRole('progressbar', { name: 'empty.bin 上传进度' })).toHaveLength(2);
    expect(screen.getAllByRole('progressbar', { name: 'empty.bin 上传进度' }).every((progressbar) => (
      progressbar.getAttribute('value') === '100'
    ))).toBe(true);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    await act(async () => completeRequest.resolve({ data: { file_id: 'empty-file' } } as never));
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
  });

  it('resumes a zero-byte pending upload without requesting a nonexistent part', async () => {
    const emptyPending = { ...pendingUpload, upload_id: 'empty-pending', upload_token: 'empty-token', filename: 'empty.bin', size: 0 };
    localStorage.setItem(`fs_upload_${emptyPending.upload_id}`, JSON.stringify(emptyPending));
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus({
      id: emptyPending.upload_id,
      expected_size: 0,
      received_parts: [],
      received_size: 0,
      total_parts: 0,
    }) } as never);
    mockedApi.post
      .mockResolvedValueOnce({ data: { received_parts: [], chunk_size: 4 } } as never)
      .mockResolvedValueOnce({ data: { file_id: 'empty-file' } } as never);
    const onUploadComplete = vi.fn();
    render(<FileUpload onUploadComplete={onUploadComplete} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: '继续上传 empty.bin' }));
    fireEvent.change(screen.getByLabelText('选择待恢复文件'), { target: { files: [makeFile('empty.bin', 0)] } });

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mockedApi.put).not.toHaveBeenCalled();
    expect(mockedApi.post).toHaveBeenCalledWith(
      `/uploads/${emptyPending.upload_id}/resume`,
      undefined,
      { 'X-Upload-Token': emptyPending.upload_token },
      expect.any(AbortSignal),
    );
    expect(localStorage.getItem(`fs_upload_${emptyPending.upload_id}`)).toBeNull();
  });

  it('retains an aborted in-flight complete response until remount confirms the terminal state', async () => {
    const emptyPending = { ...pendingUpload, upload_id: 'complete-pending', upload_token: 'complete-token', filename: 'complete.bin', size: 0 };
    localStorage.setItem(`fs_upload_${emptyPending.upload_id}`, JSON.stringify(emptyPending));
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus({
      id: emptyPending.upload_id,
      expected_size: 0,
      received_parts: [],
      received_size: 0,
      total_parts: 0,
    }) } as never);
    const completeRequest = deferred<never>();
    mockedApi.post.mockImplementation((path) => {
      if (path === `/uploads/${emptyPending.upload_id}/resume`) {
        return Promise.resolve({ data: { received_parts: [], chunk_size: 4 } }) as never;
      }
      if (path === `/uploads/${emptyPending.upload_id}/complete`) return completeRequest.promise as never;
      return Promise.resolve({ data: {} }) as never;
    });
    const firstMount = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: '继续上传 complete.bin' }));
    fireEvent.change(screen.getByLabelText('选择待恢复文件'), { target: { files: [makeFile('complete.bin', 0)] } });
    await waitFor(() => expect(mockedApi.post.mock.calls.some(([path]) => path === `/uploads/${emptyPending.upload_id}/complete`)).toBe(true));
    const completeSignal = mockedApi.post.mock.calls.find(([path]) => path === `/uploads/${emptyPending.upload_id}/complete`)?.[3] as AbortSignal | undefined;

    firstMount.unmount();
    await act(async () => { completeRequest.resolve({ data: { file_id: 'committed-file' } } as never); });

    expect(completeSignal).toBeInstanceOf(AbortSignal);
    expect(completeSignal?.aborted).toBe(true);
    expect(localStorage.getItem(`fs_upload_${emptyPending.upload_id}`)).not.toBeNull();

    mockedApi.get.mockResolvedValueOnce({ data: activeStatus({
      id: emptyPending.upload_id,
      status: 'completed',
      expected_size: 0,
      received_parts: [],
      received_size: 0,
      total_parts: 0,
    }) } as never);
    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    await waitFor(() => expect(localStorage.getItem(`fs_upload_${emptyPending.upload_id}`)).toBeNull());
    expect(mockedApi.post.mock.calls.filter(([path]) => path === `/uploads/${emptyPending.upload_id}/resume`)).toHaveLength(1);
  });

  it('does not remove local state when discard is canceled or its remote outcome is ambiguous', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    const confirmation = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirmation);
    mockedApi.delete.mockRejectedValueOnce(apiFailure(409, 'UPLOAD_BUSY'));
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);
    const discardButton = await screen.findByRole('button', { name: /放弃上传/ });

    fireEvent.click(discardButton);
    expect(mockedApi.delete).not.toHaveBeenCalled();
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();

    fireEvent.click(discardButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('续传记录仍已保留');
    expect(mockedApi.delete).toHaveBeenCalledWith(
      `/uploads/${pendingUpload.upload_id}`,
      { 'X-Upload-Token': pendingUpload.upload_token },
      expect.any(AbortSignal),
    );
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
    expect(container.textContent).not.toContain(pendingUpload.upload_token);
  });

  it('removes local state when abort succeeds or the server confirms the session is already gone', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    mockedApi.delete.mockRejectedValueOnce(apiFailure(410));
    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);
    const discardButton = await screen.findByRole('button', { name: /放弃上传/ });

    fireEvent.click(discardButton);

    await waitFor(() => expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).toBeNull());
    expect(screen.queryByText('payload.bin')).not.toBeInTheDocument();
  });

  it('keeps the pending record after a network failure while abandoning', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    mockedApi.delete.mockRejectedValueOnce(new TypeError('network unavailable'));
    render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /放弃上传/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('续传记录仍已保留');
    expect(localStorage.getItem(`fs_upload_${pendingUpload.upload_id}`)).not.toBeNull();
    expect(document.body.textContent).not.toContain(pendingUpload.upload_token);
  });

  it('hides the resume picker from keyboard and screen-reader navigation while the Continue button opens it', async () => {
    seedPending();
    mockedApi.get.mockResolvedValueOnce({ data: activeStatus() } as never);
    const { container } = render(<FileUpload onUploadComplete={vi.fn()} folderId={null} />);
    const continueButton = await screen.findByRole('button', { name: '继续上传 payload.bin' });
    const resumeInput = container.querySelector('input[aria-label="选择待恢复文件"]');
    if (!(resumeInput instanceof HTMLInputElement)) throw new Error('Expected resume file input');
    const openPicker = vi.spyOn(resumeInput, 'click');

    expect(resumeInput).toHaveAttribute('hidden');
    expect(resumeInput).toHaveAttribute('aria-hidden', 'true');
    expect(resumeInput).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('点击“继续”后，请重新选择最初上传的同一个文件（文件名和大小需匹配）。')).toBeVisible();
    fireEvent.click(continueButton);
    expect(openPicker).toHaveBeenCalledTimes(1);
  });
});
