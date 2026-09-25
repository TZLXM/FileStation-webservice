import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function deriveKey(jwtSecret: string): Buffer {
  if (!jwtSecret) throw new Error('JWT encryption key is unavailable');
  return createHash('sha256').update(jwtSecret, 'utf8').digest();
}

function decodeBase64(value: string): Buffer {
  if (!value || !BASE64.test(value)) throw new Error('Encrypted TOTP secret is malformed');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Encrypted TOTP secret is malformed');
  return decoded;
}

export function encryptSecret(plain: string, jwtSecret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(jwtSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptSecret(payload: string, jwtSecret: string): string {
  if (typeof payload !== 'string') throw new Error('Encrypted TOTP secret is malformed');
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Encrypted TOTP secret is malformed');
  }

  const iv = decodeBase64(parts[1]);
  const authTag = decodeBase64(parts[2]);
  const ciphertext = decodeBase64(parts[3]);
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH || ciphertext.length === 0) {
    throw new Error('Encrypted TOTP secret is malformed');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(jwtSecret), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Encrypted TOTP secret is invalid');
  }
}
