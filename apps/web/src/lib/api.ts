import { ApiResponse } from '@filestation/shared';
import { apiPath } from './base-url';
import {
  isMaintenanceFailure,
  maintenanceStore,
} from './maintenance';

export type UploadApiStatus = 'initiated' | 'uploading' | 'verifying' | 'completed' | 'aborted' | 'expired' | 'failed';

const UPLOAD_API_STATUSES = new Set<UploadApiStatus>([
  'initiated', 'uploading', 'verifying', 'completed', 'aborted', 'expired', 'failed',
]);

export class ApiError extends Error {
  readonly retryAfterSeconds?: number;
  readonly targetVersion?: string;
  readonly attemptId?: string;

  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly currentStatus?: UploadApiStatus,
    metadata: {
      retryAfterSeconds?: number;
      targetVersion?: string;
      attemptId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryAfterSeconds = metadata.retryAfterSeconds;
    this.targetVersion = metadata.targetVersion;
    this.attemptId = metadata.attemptId;
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers?.get('Retry-After');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function maintenanceRecoveryRequest(method: string, path: string): boolean {
  const route = path.split(/[?#]/, 1)[0];
  return (method === 'GET' && ['/updates/status', '/auth/status'].includes(route))
    || (method === 'POST' && [
      '/auth/login', '/auth/login/totp', '/auth/recovery/verify', '/auth/refresh', '/auth/logout',
    ].includes(route));
}

class ApiClient {
  private accessToken: string | null = null;
  private sessionGeneration = 0;

  setAccessToken(token: string | null) {
    if (token !== this.accessToken) {
      this.sessionGeneration++;
      maintenanceStore.getState().reset();
    }
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: BodyInit | object,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const maintenance = maintenanceStore.getState();
    const generation = this.sessionGeneration;
    if (maintenance.active && !maintenanceRecoveryRequest(method, path)) {
      throw new ApiError(
        503,
        'FileStation is temporarily unavailable while an update is prepared',
        'UPDATE_MAINTENANCE',
        undefined,
        { retryAfterSeconds: maintenance.retryAfterSeconds },
      );
    }

    const url = apiPath(path);
    const requestHeaders: Record<string, string> = { ...headers };

    const isRaw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof FormData;
    if (!isRaw && body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    // v1.6 修正：调用方显式传入 Authorization（如分享页 download token）时不覆盖；
    // 大小写不敏感检查，防 Bearer a, Bearer b 双头
    const hasAuth = Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'authorization');
    if (this.accessToken && !hasAuth) {
      requestHeaders['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: isRaw ? (body as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const code = typeof body.code === 'string' ? body.code : undefined;
      const message = typeof body.message === 'string' && body.message.length > 0 ? body.message : 'Request failed';
      const current = typeof body.current === 'string' && UPLOAD_API_STATUSES.has(body.current as UploadApiStatus)
        ? body.current as UploadApiStatus
        : undefined;
      const error = new ApiError(response.status, message, code, current, {
        retryAfterSeconds: retryAfterSeconds(response),
        targetVersion:
          typeof body.target_version === 'string' ? body.target_version : undefined,
        attemptId:
          typeof body.attempt_id === 'string' ? body.attempt_id : undefined,
      });
      if (generation === this.sessionGeneration && !signal?.aborted && isMaintenanceFailure(error)) {
        maintenanceStore.getState().activate(error);
      }
      throw error;
    }
    return response.json();
  }

  async get<T>(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return this.request<ApiResponse<T>>('GET', path, undefined, headers, signal);
  }

  async post<T>(path: string, body?: BodyInit | object, headers?: Record<string, string>, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return this.request<ApiResponse<T>>('POST', path, body, headers, signal);
  }

  async put<T>(path: string, body?: BodyInit | object, headers?: Record<string, string>, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return this.request<ApiResponse<T>>('PUT', path, body, headers, signal);
  }

  async patch<T>(path: string, body?: BodyInit | object): Promise<ApiResponse<T>> {
    return this.request<ApiResponse<T>>('PATCH', path, body);
  }

  async delete<T>(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return this.request<ApiResponse<T>>('DELETE', path, undefined, headers, signal);
  }

  /** Endpoints such as updates return a raw JSON object, without ApiResponse.data. */
  async getRaw<T>(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, headers, signal);
  }

  async postRaw<T>(path: string, body?: BodyInit | object, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, body, headers, signal);
  }

  /** v1.6 新增：管理员直接下载（GET /files/:id/content，fetch blob + a[download]） */
  async downloadFile(fileId: string, filename: string): Promise<void> {
    const maintenance = maintenanceStore.getState();
    if (maintenance.active) {
      throw new ApiError(
        503,
        'FileStation is temporarily unavailable while an update is prepared',
        'UPDATE_MAINTENANCE',
        undefined,
        { retryAfterSeconds: maintenance.retryAfterSeconds },
      );
    }
    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const response = await fetch(apiPath(`/files/${fileId}/content`), {
      headers,
      credentials: 'include',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const body = typeof payload === 'object' && payload !== null
        ? payload as Record<string, unknown>
        : {};
      const error = new ApiError(
        response.status,
        typeof body.message === 'string' && body.message
          ? body.message
          : 'Download failed',
        typeof body.code === 'string' ? body.code : undefined,
        undefined,
        { retryAfterSeconds: retryAfterSeconds(response) },
      );
      if (isMaintenanceFailure(error)) maintenanceStore.getState().activate(error);
      throw error;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export const api = new ApiClient();
