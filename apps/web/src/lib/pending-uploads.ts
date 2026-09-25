export interface PendingUpload {
  upload_id: string;
  upload_token: string;
  chunk_size: number;
  filename: string;
  size: number;
  folder_id: string | null;
  saved_at: number;
}

const PREFIX = 'fs_upload_';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FIELDS = ['upload_id', 'upload_token', 'chunk_size', 'filename', 'size', 'folder_id', 'saved_at'];

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value);
}

function validate(value: unknown, key: string, now: number): value is PendingUpload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== FIELDS.length || keys.some((field, index) => field !== [...FIELDS].sort()[index])) return false;
  if (typeof candidate.upload_id !== 'string' || candidate.upload_id.trim().length === 0) return false;
  if (key !== `${PREFIX}${candidate.upload_id}`) return false;
  if (typeof candidate.upload_token !== 'string' || candidate.upload_token.trim().length === 0) return false;
  if (candidate.upload_token.trim() !== candidate.upload_token) return false;
  if (!isSafeInteger(candidate.chunk_size) || candidate.chunk_size <= 0) return false;
  if (typeof candidate.filename !== 'string' || candidate.filename.length === 0) return false;
  if (!isSafeInteger(candidate.size) || candidate.size < 0) return false;
  if (candidate.folder_id !== null && (typeof candidate.folder_id !== 'string' || candidate.folder_id.length === 0)) return false;
  if (!isSafeInteger(candidate.saved_at) || candidate.saved_at < 0 || candidate.saved_at > now) return false;
  return now - candidate.saved_at < MAX_AGE_MS;
}

function tryRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be disabled or read-only. A cleanup failure must not interrupt uploads.
  }
}

export function savePending(upload: PendingUpload): boolean {
  const storage = getStorage();
  if (!storage || !validate(upload, `${PREFIX}${upload.upload_id}`, Date.now())) return false;
  try {
    storage.setItem(`${PREFIX}${upload.upload_id}`, JSON.stringify(upload));
    return true;
  } catch {
    return false;
  }
}

export function removePending(uploadId: string): boolean {
  if (typeof uploadId !== 'string' || uploadId.trim().length === 0) return false;
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(`${PREFIX}${uploadId}`);
    return true;
  } catch {
    return false;
  }
}

export function listPending(): PendingUpload[] {
  const storage = getStorage();
  if (!storage) return [];

  let keys: string[];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(PREFIX));
  } catch {
    return [];
  }

  const now = Date.now();
  const pending: PendingUpload[] = [];
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      if (validate(value, key, now)) pending.push(value);
      else tryRemove(storage, key);
    } catch {
      tryRemove(storage, key);
    }
  }
  return pending;
}
