type CipherApi = {
  encryptSecret: (plain: string, jwtSecret: string) => string;
  decryptSecret: (payload: string, jwtSecret: string) => string;
};

function loadCipher(): CipherApi | null {
  try {
    return require('./totp-secret-cipher') as CipherApi;
  } catch {
    return null;
  }
}

describe('TOTP secret cipher', () => {
  it('encrypts with a versioned authenticated envelope and decrypts with the configured key', () => {
    const cipher = loadCipher();
    expect(cipher).not.toBeNull();
    if (!cipher) return;

    const plaintext = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = cipher.encryptSecret(plaintext, 'unit-test-key');

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/);
    expect(encrypted).not.toContain(plaintext);
    expect(cipher.decryptSecret(encrypted, 'unit-test-key')).toBe(plaintext);
  });

  it('rejects authenticated ciphertext changes and a different key', () => {
    const cipher = loadCipher();
    expect(cipher).not.toBeNull();
    if (!cipher) return;

    const encrypted = cipher.encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'unit-test-key');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[3], 'base64');
    ciphertext[0] ^= 1;
    parts[3] = ciphertext.toString('base64');

    expect(() => cipher.decryptSecret(parts.join('.'), 'unit-test-key')).toThrow();
    expect(() => cipher.decryptSecret(encrypted, 'another-test-key')).toThrow();
  });

  it('rejects malformed versions, components, and non-canonical base64', () => {
    const cipher = loadCipher();
    expect(cipher).not.toBeNull();
    if (!cipher) return;

    const encrypted = cipher.encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'unit-test-key');
    const parts = encrypted.split('.');
    const malformed = [
      'v2.a.b.c',
      'v1.a.b',
      `${encrypted}.extra`,
      'v1.!!!!.AQIDBAUGBwgJCgsM.AQ==',
      `v1.${Buffer.from('short').toString('base64')}.${parts[2]}.${parts[3]}`,
      `v1.${parts[1]}.${Buffer.from('short').toString('base64')}.${parts[3]}`,
    ];

    for (const payload of malformed) {
      expect(() => cipher.decryptSecret(payload, 'unit-test-key')).toThrow();
    }
  });
});
