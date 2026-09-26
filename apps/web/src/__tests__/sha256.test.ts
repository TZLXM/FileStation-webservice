// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sha256ComputationError, sha256Hex } from '../lib/sha256';

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const helloBuffer = new TextEncoder().encode('hello').buffer as ArrayBuffer;

describe('sha256Hex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses native WebCrypto and returns the exact lowercase SHA-256 hex', async () => {
    const digest = vi.fn((algorithm: AlgorithmIdentifier, data: BufferSource) => webcrypto.subtle.digest(algorithm, data));
    vi.stubGlobal('crypto', { subtle: { digest } });

    await expect(sha256Hex(helloBuffer)).resolves.toBe(HELLO_SHA256);
    expect(digest).toHaveBeenCalledWith('SHA-256', helloBuffer);
  });

  it('uses the fallback and returns the exact lowercase SHA-256 hex without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { subtle: undefined });

    await expect(sha256Hex(helloBuffer)).resolves.toBe(HELLO_SHA256);
  });

  it('falls back when native WebCrypto digest rejects', async () => {
    const digest = vi.fn().mockRejectedValue(new Error('digest unavailable'));
    vi.stubGlobal('crypto', { subtle: { digest } });

    await expect(sha256Hex(helloBuffer)).resolves.toBe(HELLO_SHA256);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('throws a checksum-specific error when native and fallback hashing both fail', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('digest unavailable')) } });
    const invalidBuffer = Object.defineProperty({}, 'length', {
      get() { throw new Error('invalid buffer source'); },
    }) as unknown as ArrayBuffer;

    await expect(sha256Hex(invalidBuffer)).rejects.toBeInstanceOf(Sha256ComputationError);
  });
});
