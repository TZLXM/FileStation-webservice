// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPending, removePending, savePending, type PendingUpload } from '../lib/pending-uploads';

const now = 1_800_000_000_000;

function record(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    upload_id: 'upload-1',
    upload_token: 'opaque-upload-token',
    chunk_size: 4,
    filename: 'payload.bin',
    size: 8,
    folder_id: null,
    saved_at: now,
    ...overrides,
  };
}

describe('pending upload storage', () => {
  const browserStorage = window.localStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    browserStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    browserStorage.clear();
  });

  it('round-trips a complete pending upload under the matching key', () => {
    expect(savePending(record())).toBe(true);

    expect(listPending()).toEqual([record()]);
    expect(browserStorage.getItem('fs_upload_upload-1')).toBe(JSON.stringify(record()));
  });

  it('rejects unsafe or incomplete records and removes their entries', () => {
    const invalid: unknown[] = [
      { ...record(), upload_token: '  ' },
      { ...record(), upload_id: '' },
      { ...record(), chunk_size: 0 },
      { ...record(), chunk_size: Number.MAX_SAFE_INTEGER + 1 },
      { ...record(), size: -1 },
      { ...record(), size: 1.5 },
      { ...record(), filename: '' },
      { ...record(), folder_id: 12 },
      { ...record(), folder_id: '' },
      { ...record(), saved_at: Number.POSITIVE_INFINITY },
      { ...record(), saved_at: 4.5 },
      { ...record(), saved_at: now + 1 },
      { ...record(), upload_token: 'opaque-upload-token ' },
      (({ filename: _filename, ...withoutFilename }) => withoutFilename)(record()),
      { ...record(), unexpected: 'field' },
    ];
    invalid.forEach((value, index) => browserStorage.setItem(`fs_upload_bad-${index}`, JSON.stringify(value)));
    browserStorage.setItem('fs_upload_malformed-json', '{');

    expect(listPending()).toEqual([]);
    expect(browserStorage.length).toBe(0);
    expect(savePending(record({ size: Number.MAX_SAFE_INTEGER + 1 }))).toBe(false);
  });

  it('requires each key suffix to match the record upload id', () => {
    browserStorage.setItem('fs_upload_other-id', JSON.stringify(record()));

    expect(listPending()).toEqual([]);
    expect(browserStorage.getItem('fs_upload_other-id')).toBeNull();
  });

  it('expires exactly at 24 hours while retaining an entry one millisecond younger', () => {
    browserStorage.setItem('fs_upload_expired', JSON.stringify(record({ upload_id: 'expired', saved_at: now - 86_400_000 })));
    browserStorage.setItem('fs_upload_fresh', JSON.stringify(record({ upload_id: 'fresh', saved_at: now - 86_399_999 })));

    expect(listPending()).toEqual([record({ upload_id: 'fresh', saved_at: now - 86_399_999 })]);
    expect(browserStorage.getItem('fs_upload_expired')).toBeNull();
  });

  it('snapshots keys before deleting malformed records so later entries are not skipped', () => {
    browserStorage.setItem('fs_upload_bad-a', 'invalid');
    browserStorage.setItem('fs_upload_bad-b', 'invalid');
    browserStorage.setItem('fs_upload_good', JSON.stringify(record({ upload_id: 'good' })));

    expect(listPending()).toEqual([record({ upload_id: 'good' })]);
    expect(browserStorage.getItem('fs_upload_bad-a')).toBeNull();
    expect(browserStorage.getItem('fs_upload_bad-b')).toBeNull();
  });

  it('contains storage access errors and reports failed writes/removals', () => {
    const inaccessibleStorage = {
      get length() { throw new DOMException('blocked', 'SecurityError'); },
      key: () => null,
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      clear: () => undefined,
    };
    vi.stubGlobal('localStorage', inaccessibleStorage);

    expect(listPending()).toEqual([]);
    expect(savePending(record())).toBe(false);
    expect(removePending('upload-1')).toBe(false);
  });
});
