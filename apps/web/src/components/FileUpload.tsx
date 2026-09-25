import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { ApiError, api, type UploadApiStatus } from '../lib/api';
import { listPending, removePending, savePending, type PendingUpload } from '../lib/pending-uploads';
import type { UploadInitResponse, UploadStatus } from '@filestation/shared';

type ProbeState = 'checking' | 'ready' | 'error';

interface ResumableUpload extends PendingUpload {
  received_parts: number[];
  total_parts: number;
  probe_state: ProbeState;
  probe_error?: string;
}

type Feedback = { role: 'alert' | 'status'; text: string };
type Operation = 'upload' | 'discard';

class InvalidResumeResponseError extends Error {
  constructor() {
    super('服务器返回的续传分块状态无效，续传记录已保留，可稍后重试。');
  }
}

const ACTIVE_STATUSES = new Set<UploadApiStatus>(['initiated', 'uploading']);
const TERMINAL_STATUSES = new Set<UploadApiStatus>(['completed', 'aborted', 'expired', 'failed']);

function normalizeParts(value: unknown, totalParts: number): number[] | null {
  if (!Array.isArray(value)) return null;
  const parts = new Set<number>();
  for (const part of value) {
    if (!Number.isSafeInteger(part) || part < 0 || part >= totalParts || parts.has(part)) return null;
    parts.add(part);
  }
  return [...parts].sort((a, b) => a - b);
}

function percentComplete(totalParts: number, completedParts: number): number {
  if (totalParts === 0) return 100;
  return Math.min(100, Math.round((completedParts / totalParts) * 100));
}

function isTerminalStatus(status: unknown): status is UploadApiStatus {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status as UploadApiStatus);
}

function isConfirmedTerminalError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 410) return true;
  return error.code === 'INVALID_UPLOAD_STATE' && isTerminalStatus(error.currentStatus);
}

function safeUploadPath(uploadId: string): string {
  return encodeURIComponent(uploadId);
}

export default function FileUpload({ onUploadComplete, folderId }: {
  onUploadComplete: () => void;
  folderId: string | null;
}) {
  const [busyOperation, setBusyOperation] = useState<Operation | null>(null);
  const [currentFilename, setCurrentFilename] = useState('');
  const [progress, setProgress] = useState(0);
  const [resumables, setResumables] = useState<ResumableUpload[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [checkingUploadId, setCheckingUploadId] = useState<string | null>(null);
  const operationRef = useRef(false);
  const pendingSavedRef = useRef(new Map<string, boolean>());
  const probeVersionsRef = useRef(new Map<string, number>());
  const probeLifecycleRef = useRef(0);
  const resumeTargetRef = useRef<ResumableUpload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const beginOperation = useCallback((operation: Operation): boolean => {
    if (operationRef.current) return false;
    operationRef.current = true;
    setBusyOperation(operation);
    setFeedback(null);
    return true;
  }, []);

  const finishOperation = useCallback(() => {
    operationRef.current = false;
    setBusyOperation(null);
    setCurrentFilename('');
    setProgress(0);
  }, []);

  const upsertResumable = useCallback((entry: ResumableUpload) => {
    setResumables((current) => {
      const existing = current.findIndex((item) => item.upload_id === entry.upload_id);
      if (existing < 0) return [...current, entry];
      return current.map((item, index) => index === existing ? entry : item);
    });
  }, []);

  const forgetPending = useCallback((uploadId: string) => {
    const removed = removePending(uploadId);
    pendingSavedRef.current.delete(uploadId);
    setResumables((current) => current.filter((item) => item.upload_id !== uploadId));
    if (!removed) {
      setStorageWarning('浏览器无法更新本地续传状态；已结束的上传会在下次核实时再次确认。');
    }
    return removed;
  }, []);

  const markProbeFailed = useCallback((uploadId: string, message: string) => {
    setResumables((current) => current.map((item) => item.upload_id === uploadId
      ? { ...item, probe_state: 'error', probe_error: message }
      : item));
  }, []);

  const probeUpload = useCallback(async (entry: PendingUpload, stillCurrent: () => boolean) => {
    const version = (probeVersionsRef.current.get(entry.upload_id) ?? 0) + 1;
    probeVersionsRef.current.set(entry.upload_id, version);
    const isCurrent = () => stillCurrent() && probeVersionsRef.current.get(entry.upload_id) === version;
    setCheckingUploadId(entry.upload_id);
    setResumables((current) => current.map((item) => item.upload_id === entry.upload_id
      ? { ...item, probe_state: 'checking', probe_error: undefined }
      : item));

    try {
      const response = await api.get<UploadStatus>(`/uploads/${safeUploadPath(entry.upload_id)}`, {
        'X-Upload-Token': entry.upload_token,
      });
      if (!isCurrent()) return;

      const status = response.data?.status;
      if (response.data?.id !== entry.upload_id || response.data.expected_size !== entry.size || typeof status !== 'string') {
        markProbeFailed(entry.upload_id, '服务器返回的上传状态无法识别，续传记录已保留。');
        return;
      }
      if (isTerminalStatus(status)) {
        forgetPending(entry.upload_id);
        return;
      }
      if (!ACTIVE_STATUSES.has(status as UploadApiStatus)) {
        markProbeFailed(entry.upload_id, '服务器暂不能续传此任务，记录已保留；可稍后重新检查。');
        return;
      }

      const totalParts = response.data.total_parts;
      const receivedSize = response.data.received_size;
      if (!Number.isSafeInteger(totalParts) || totalParts < 0
        || (entry.size === 0 ? totalParts !== 0 : totalParts === 0)
        || !Number.isSafeInteger(receivedSize) || receivedSize < 0 || receivedSize > entry.size) {
        markProbeFailed(entry.upload_id, '服务器返回的上传状态无效，续传记录已保留。');
        return;
      }
      const receivedParts = normalizeParts(response.data.received_parts, totalParts);
      if (!receivedParts) {
        markProbeFailed(entry.upload_id, '服务器返回的分块状态无效，续传记录已保留。');
        return;
      }

      setResumables((current) => current.map((item) => item.upload_id === entry.upload_id
        ? { ...item, received_parts: receivedParts, total_parts: totalParts, probe_state: 'ready', probe_error: undefined }
        : item));
      pendingSavedRef.current.set(entry.upload_id, true);
    } catch (error) {
      if (!isCurrent()) return;
      if (isConfirmedTerminalError(error)) {
        forgetPending(entry.upload_id);
        return;
      }
      markProbeFailed(entry.upload_id, '暂时无法确认上传状态，续传记录已保留；可重试状态检查。');
    } finally {
      if (isCurrent()) setCheckingUploadId((current) => current === entry.upload_id ? null : current);
    }
  }, [forgetPending, markProbeFailed]);

  useEffect(() => {
    const lifecycle = ++probeLifecycleRef.current;
    let active = true;
    const entries = listPending();
    entries.forEach((entry) => pendingSavedRef.current.set(entry.upload_id, true));
    setResumables(entries.map((entry) => ({
      ...entry,
      received_parts: [],
      total_parts: entry.size === 0 ? 0 : Math.ceil(entry.size / entry.chunk_size),
      probe_state: 'checking',
    })));
    const stillCurrent = () => active && probeLifecycleRef.current === lifecycle;
    entries.forEach((entry) => { void probeUpload(entry, stillCurrent); });

    return () => {
      active = false;
      probeLifecycleRef.current += 1;
    };
  }, [probeUpload]);

  const uploadChunks = useCallback(async (file: File, entry: PendingUpload, alreadyReceived: number[]) => {
    const totalParts = Math.ceil(file.size / entry.chunk_size);
    const skip = new Set(alreadyReceived);
    let completedParts = skip.size;
    setProgress(percentComplete(totalParts, completedParts));

    for (let partNumber = 0; partNumber < totalParts; partNumber += 1) {
      if (skip.has(partNumber)) continue;
      const start = partNumber * entry.chunk_size;
      const end = Math.min(start + entry.chunk_size, file.size);
      const chunk = file.slice(start, end);
      const buffer = await chunk.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const checksum = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');

      await api.put(`/uploads/${safeUploadPath(entry.upload_id)}/parts/${partNumber}`, chunk, {
        'X-Upload-Token': entry.upload_token,
        'X-Part-Checksum': checksum,
      });
      completedParts += 1;
      setProgress(percentComplete(totalParts, completedParts));
      setResumables((current) => current.map((item) => item.upload_id === entry.upload_id
        ? {
            ...item,
            received_parts: [...new Set([...item.received_parts, partNumber])].sort((a, b) => a - b),
            probe_state: 'ready',
          }
        : item));
    }

    setProgress(percentComplete(totalParts, totalParts));
    await api.post(`/uploads/${safeUploadPath(entry.upload_id)}/complete`, {}, {
      'X-Upload-Token': entry.upload_token,
    });
    forgetPending(entry.upload_id);
    setFeedback({ role: 'status', text: `${file.name} 上传完成。` });
    onUploadComplete();
  }, [forgetPending, onUploadComplete]);

  const handleDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file || !beginOperation('upload')) return;
    setCurrentFilename(file.name);
    setProgress(0);
    let pending: PendingUpload | null = null;

    try {
      const initResponse = await api.post<UploadInitResponse>('/uploads', {
        filename: file.name,
        size: file.size,
        folder_id: folderId ?? undefined,
      });
      const data = initResponse.data;
      if (!data || typeof data.upload_id !== 'string' || data.upload_id.trim().length === 0
        || typeof data.upload_token !== 'string' || data.upload_token.trim().length === 0
        || !Number.isSafeInteger(data.chunk_size) || data.chunk_size <= 0) {
        throw new Error('Invalid upload initialization response');
      }

      pending = {
        upload_id: data.upload_id,
        upload_token: data.upload_token,
        chunk_size: data.chunk_size,
        filename: file.name,
        size: file.size,
        folder_id: folderId,
        saved_at: Date.now(),
      };
      const persisted = savePending(pending);
      pendingSavedRef.current.set(pending.upload_id, persisted);
      setStorageWarning(persisted ? null : '无法保存续传状态，上传会继续；如果上传中断，请保持当前页面并稍后重试。');
      upsertResumable({
        ...pending,
        received_parts: [],
        total_parts: file.size === 0 ? 0 : Math.ceil(file.size / pending.chunk_size),
        probe_state: 'ready',
      });
      await uploadChunks(file, pending, []);
    } catch {
      const saved = pending !== null && pendingSavedRef.current.get(pending.upload_id) === true;
      setFeedback({
        role: 'alert',
        text: pending
          ? saved ? '上传中断，续传状态已保留，可稍后继续。' : '上传中断且无法保存续传状态；请保持当前页面并稍后重试。'
          : '无法启动上传，请重试。',
      });
    } finally {
      finishOperation();
    }
  }, [beginOperation, finishOperation, folderId, upsertResumable, uploadChunks]);

  const retryProbe = useCallback((entry: ResumableUpload) => {
    if (operationRef.current) return;
    const lifecycle = probeLifecycleRef.current;
    void probeUpload(entry, () => probeLifecycleRef.current === lifecycle);
  }, [probeUpload]);

  const handleResumeFilePicked = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    const target = resumeTargetRef.current;
    event.currentTarget.value = '';
    resumeTargetRef.current = null;
    if (!file || !target || !beginOperation('upload')) return;
    setCurrentFilename(file.name);

    try {
      if (file.name !== target.filename || file.size !== target.size) {
        setFeedback({ role: 'alert', text: '所选文件与待恢复上传不匹配，请重新选择原文件。' });
        return;
      }

      const response = await api.post<{ received_parts: number[]; chunk_size: number }>(
        `/uploads/${safeUploadPath(target.upload_id)}/resume`,
        undefined,
        { 'X-Upload-Token': target.upload_token },
      );
      const data = response.data;
      if (!data || !Number.isSafeInteger(data.chunk_size) || data.chunk_size <= 0) {
        throw new InvalidResumeResponseError();
      }
      const totalParts = Math.ceil(file.size / data.chunk_size);
      const receivedParts = normalizeParts(data.received_parts, totalParts);
      if (!receivedParts) throw new InvalidResumeResponseError();

      const resumedEntry: PendingUpload = {
        upload_id: target.upload_id,
        upload_token: target.upload_token,
        chunk_size: data.chunk_size,
        filename: target.filename,
        size: target.size,
        folder_id: target.folder_id,
        saved_at: Date.now(),
      };
      const persisted = savePending(resumedEntry);
      pendingSavedRef.current.set(target.upload_id, persisted);
      setStorageWarning(persisted ? null : '无法保存续传状态，上传会继续；如果上传中断，请保持当前页面并稍后重试。');
      setResumables((current) => current.map((item) => item.upload_id === target.upload_id
        ? { ...item, ...resumedEntry, received_parts: receivedParts, total_parts: totalParts, probe_state: 'ready', probe_error: undefined }
        : item));
      await uploadChunks(file, resumedEntry, receivedParts);
    } catch (error) {
      if (isConfirmedTerminalError(error)) {
        forgetPending(target.upload_id);
        setFeedback({ role: 'status', text: '服务器确认该上传已结束，续传记录已清理。' });
      } else {
        const saved = pendingSavedRef.current.get(target.upload_id) === true;
        setFeedback({
          role: 'alert',
          text: error instanceof InvalidResumeResponseError
            ? error.message
            : saved
            ? '无法继续上传，续传状态已保留，可重试。'
            : '无法继续上传，也无法保存续传状态；请保持当前页面并稍后重试。',
        });
      }
    } finally {
      finishOperation();
    }
  }, [beginOperation, finishOperation, forgetPending, uploadChunks]);

  const handleDiscard = useCallback(async (entry: ResumableUpload) => {
    if (!beginOperation('discard')) return;
    try {
      const confirmed = window.confirm(`放弃「${entry.filename}」的上传？已传分块将被清理。`);
      if (!confirmed) return;
      await api.delete(`/uploads/${safeUploadPath(entry.upload_id)}`, {
        'X-Upload-Token': entry.upload_token,
      });
      forgetPending(entry.upload_id);
      setFeedback({ role: 'status', text: `已放弃「${entry.filename}」的上传。` });
    } catch (error) {
      if (isConfirmedTerminalError(error)) {
        forgetPending(entry.upload_id);
        setFeedback({ role: 'status', text: '服务器确认该上传已结束，续传记录已清理。' });
      } else {
        setFeedback({ role: 'alert', text: `无法确认「${entry.filename}」已放弃，续传记录仍已保留；可重试。` });
      }
    } finally {
      finishOperation();
    }
  }, [beginOperation, finishOperation, forgetPending]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleDrop,
    disabled: busyOperation !== null,
  });
  const operationInProgress = busyOperation !== null;

  return (
    <div className="space-y-4">
      {storageWarning && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{storageWarning}</p>}
      {feedback && <p role={feedback.role} aria-live={feedback.role === 'alert' ? 'assertive' : 'polite'} className="text-sm">{feedback.text}</p>}

      {resumables.length > 0 && (
        <section role="region" aria-label="待续传上传" className="rounded-lg border border-amber-200 bg-amber-50 p-3 sm:p-4">
          <h2 className="mb-3 text-sm font-medium text-amber-950">可继续的上传</h2>
          <ul className="space-y-3">
            {resumables.map((entry) => {
              const percentage = percentComplete(entry.total_parts, entry.received_parts.length);
              const isChecking = entry.probe_state === 'checking' || checkingUploadId === entry.upload_id;
              return (
                <li key={entry.upload_id} className="flex flex-col gap-3 rounded border border-amber-200 bg-white p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm font-medium" title={entry.filename}>{entry.filename}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <progress
                        className="h-2 min-w-0 flex-1 accent-blue-600"
                        max={100}
                        value={percentage}
                        aria-label={`${entry.filename} 上传进度`}
                      />
                      <span className="shrink-0 text-xs text-gray-600">{percentage}%</span>
                    </div>
                    {isChecking && <p role="status" className="mt-1 text-xs text-gray-600">正在检查续传状态…</p>}
                    {entry.probe_error && <p role="alert" className="mt-1 text-xs text-red-700">{entry.probe_error}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    {entry.probe_state === 'error' && (
                      <button
                        type="button"
                        className="min-h-10 rounded px-3 text-sm text-blue-700 underline disabled:opacity-50"
                        onClick={() => retryProbe(entry)}
                        disabled={operationInProgress || isChecking}
                      >
                        重试检查
                      </button>
                    )}
                    <button
                      type="button"
                      className="min-h-10 rounded bg-blue-700 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`继续上传 ${entry.filename}`}
                      onClick={() => {
                        resumeTargetRef.current = entry;
                        fileInputRef.current?.click();
                      }}
                      disabled={operationInProgress || isChecking || entry.probe_state !== 'ready'}
                    >
                      继续
                    </button>
                    <button
                      type="button"
                      className="min-h-10 rounded px-3 text-sm text-red-700 underline disabled:opacity-50"
                      aria-label={`放弃上传 ${entry.filename}`}
                      onClick={() => { void handleDiscard(entry); }}
                      disabled={operationInProgress || isChecking}
                    >
                      放弃
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div
        {...getRootProps({ 'aria-label': '文件上传区域' })}
        className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors sm:p-8 ${
          busyOperation ? 'cursor-not-allowed border-gray-300 bg-gray-50' : 'cursor-pointer border-gray-300 hover:border-gray-400'
        } ${isDragActive ? 'border-blue-500 bg-blue-50' : ''}`}
      >
        <input {...getInputProps({ 'aria-label': '选择上传文件' })} />
        {busyOperation === 'upload' ? (
          <div aria-live="polite">
            <div className="mb-2 break-all text-base sm:text-lg">正在上传 {currentFilename}… {progress}%</div>
            <progress className="h-2 w-full accent-blue-600" max={100} value={progress} aria-label={`${currentFilename} 上传进度`} />
          </div>
        ) : (
          <div>
            <p className="text-base sm:text-lg">{isDragActive ? '将文件放到此处' : '拖拽文件到此处，或点击选择文件'}</p>
            <p className="mt-2 text-sm text-gray-500">支持大文件分块上传</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        aria-label="选择待恢复文件"
        className="sr-only"
        onChange={(event) => { void handleResumeFilePicked(event); }}
        disabled={operationInProgress}
      />
    </div>
  );
}
