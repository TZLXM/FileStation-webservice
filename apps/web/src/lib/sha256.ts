import { sha256 as nobleSha256 } from '@noble/hashes/sha256';

export class Sha256ComputationError extends Error {
  constructor() {
    super('Unable to compute SHA-256 checksum');
    this.name = 'Sha256ComputationError';
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', data);
      return toHex(new Uint8Array(digest));
    } catch {
      // Some HTTP origins expose crypto without a usable SubtleCrypto implementation.
    }
  }

  try {
    return toHex(nobleSha256(new Uint8Array(data)));
  } catch {
    throw new Sha256ComputationError();
  }
}
