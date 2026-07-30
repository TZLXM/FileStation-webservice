// 共享类型定义

export interface ApiResponse<T = unknown> {
  code: string;
  message: string;
  data?: T;
  request_id: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// 文件相关类型
export interface FileMetadata {
  id: string;
  filename: string;
  size: number;
  mime_type: string | null;
  hash_sha256: string | null;
  status: 'active' | 'expired' | 'deleting' | 'deleted';
  expires_at: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  download_count: number;
}

export interface FolderNode {
  id: string;
  name: string;
  parent_id: string | null;
  children?: FolderNode[];
  file_count?: number;
}

// 分享相关类型（Phase 1 仅 none/password）
export interface ShareInfo {
  id: string;
  file_id: string;
  filename: string;
  size: number;
  type: 'page';
  protection: 'none' | 'password';
  requires_password: boolean;
  expires_at: string | null;
  max_downloads: number | null;
  used_downloads: number;
}

// 认证相关类型
export interface LoginRequest {
  username: string;
  password: string;
}

// 内部 Token 类型（非 API 响应）
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// API 登录响应（不含 refresh_token，在 HttpOnly Cookie 中）
export interface LoginResponse {
  requires_second_factor: boolean;
  login_challenge?: string;
  available_methods?: string[];
  access_token?: string;
  expires_in?: number;
}

export interface JwtPayload {
  sub: string;
  username: string;
  principal_type: 'admin' | 'api_token';
  scopes?: string[];
  iat: number;
  exp: number;
}

// 上传相关类型
export interface UploadInitRequest {
  filename: string;
  size: number;
  hash?: string;
  chunk_size?: number;
  folder_id?: string;
}

export interface UploadInitResponse {
  upload_id: string;
  upload_token: string;
  chunk_size: number;
  expires_at: string;
}

export interface UploadStatus {
  id: string;
  status: 'initiated' | 'uploading' | 'verifying' | 'completed' | 'aborted' | 'expired' | 'failed';
  received_parts: number[];
  received_size: number;
  total_parts: number;
  expected_size: number;
}
