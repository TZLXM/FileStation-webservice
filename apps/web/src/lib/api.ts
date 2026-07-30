import { ApiResponse } from '@filestation/shared';

const API_BASE = '/api/v1';

class ApiClient {
  private accessToken: string | null = null;

  setAccessToken(token: string | null) {
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
  ): Promise<ApiResponse<T>> {
    const url = `${API_BASE}${path}`;
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
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ code: 'UNKNOWN', message: 'Unknown error' }));
      throw new Error(error.message || 'Request failed');
    }
    return response.json();
  }

  async get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: BodyInit | object, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body, headers);
  }

  async put<T>(path: string, body?: BodyInit | object, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, body, headers);
  }

  async patch<T>(path: string, body?: BodyInit | object): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path);
  }

  /** v1.6 新增：管理员直接下载（GET /files/:id/content，fetch blob + a[download]） */
  async downloadFile(fileId: string, filename: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const response = await fetch(`${API_BASE}/files/${fileId}/content`, {
      headers,
      credentials: 'include',
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Download failed' }));
      throw new Error(error.message || 'Download failed');
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
