import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';
import {
  absoluteAppUrl,
  apiPath,
  normalizeBasePath,
  routerBasename,
  withBasePath,
} from '../lib/base-url';

const webRoot = resolve(__dirname, '..', '..');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('canonical base URL helpers', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['fs', '/fs/'],
    ['/fs', '/fs/'],
    ['/fs/', '/fs/'],
    ['/fs//nested/', '/fs/nested/'],
  ])('normalizes base %j to %j', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it('joins internal paths with exactly one separator', () => {
    vi.stubEnv('BASE_URL', '/fs/');

    expect(withBasePath('')).toBe('/fs/');
    expect(withBasePath('/')).toBe('/fs/');
    expect(withBasePath('s/share-1')).toBe('/fs/s/share-1');
    expect(withBasePath('/s//share-1/')).toBe('/fs/s/share-1/');
    expect(withBasePath('/shares?file_id=file-1')).toBe('/fs/shares?file_id=file-1');
  });

  it('derives API, absolute app, and router URLs from the Vite base', () => {
    vi.stubEnv('BASE_URL', '/fs/');
    vi.stubGlobal('window', { location: { origin: 'https://files.example.com' } });

    expect(apiPath('/shares/share-1')).toBe('/fs/api/v1/shares/share-1');
    expect(absoluteAppUrl('/s/share-1')).toBe('https://files.example.com/fs/s/share-1');
    expect(routerBasename()).toBe('/fs');
  });

  it('uses the root base by default', () => {
    expect(normalizeBasePath(import.meta.env.BASE_URL)).toBe('/');
    expect(withBasePath('/s/share-1')).toBe('/s/share-1');
    expect(apiPath('/shares/share-1')).toBe('/api/v1/shares/share-1');
    expect(routerBasename()).toBe('/');
  });

  it.each([
    'https://example.com/file',
    'http://example.com/file',
    '//example.com/file',
    'javascript:alert(1)',
  ])('rejects external URL %s from internal helpers', (externalUrl) => {
    expect(() => withBasePath(externalUrl)).toThrow(/external|absolute/i);
    expect(() => absoluteAppUrl(externalUrl)).toThrow(/external|absolute/i);
    expect(() => apiPath(externalUrl)).toThrow(/external|absolute/i);
  });

  it('rejects external absolute URL values as a deployment base', () => {
    expect(() => normalizeBasePath('https://example.com/fs/')).toThrow(/external|absolute/i);
    expect(() => normalizeBasePath('//example.com/fs/')).toThrow(/external|absolute/i);
  });
});

describe('Vite canonical base configuration', () => {
  it('normalizes FILESTATION_BASE into the Vite base', async () => {
    vi.stubEnv('FILESTATION_BASE', 'fs//nested');

    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      resolve(webRoot, 'vite.config.ts'),
      undefined,
      'silent',
    );

    expect(loaded?.config.base).toBe('/fs/nested/');
  });

  it('uses a deployment-relative favicon and ships the referenced public asset', () => {
    const indexPath = resolve(webRoot, 'index.html');
    const html = readFileSync(indexPath, 'utf8');

    expect(html).toContain('href="%BASE_URL%favicon.svg"');
    expect(existsSync(resolve(webRoot, 'public', 'favicon.svg'))).toBe(true);
  });
});
