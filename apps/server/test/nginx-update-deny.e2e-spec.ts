import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('Nginx internal update denial fixture', () => {
  let configuration: string;
  let rootPattern: RegExp;
  let subpathPattern: RegExp;

  beforeAll(async () => {
    configuration = await readFile(
      path.resolve(__dirname, '../../../deploy/nginx/filestation.conf'),
      'utf8',
    );
    const patterns = [...configuration.matchAll(
      /location\s+~\*\s+(\^[^\s{]+)/g,
    )]
      .map((match) => match[1])
      .filter((value) => value.includes('internal/update'));
    expect(patterns).toHaveLength(2);
    rootPattern = new RegExp(patterns[0], 'i');
    subpathPattern = new RegExp(patterns[1], 'i');
  });

  it.each([
    '/api/v1/internal/update/health',
    '/api/v1/internal/update/health/',
    '/API/V1/INTERNAL/UPDATE/HEALTH',
    '/api/v1/internal/update/promote-ready',
    '/api/v1/internal/update/promote-ready/',
  ])('denies exact root internal route %s', (uri) => {
    expect(rootPattern.test(uri)).toBe(true);
  });

  it.each([
    '/fs/api/v1/internal/update/health',
    '/fs/api/v1/internal/update/health/',
    '/FS/API/V1/INTERNAL/UPDATE/PROMOTE-READY',
    '/fs/api/v1/internal/update/promote-ready/',
  ])('denies exact subpath internal route %s', (uri) => {
    expect(subpathPattern.test(uri)).toBe(true);
  });

  it.each([
    '/api/v1/updates/status',
    '/api/v1/internal/updates/health',
    '/fs/api/v1/auth/init',
  ])('does not shadow ordinary API route %s', (uri) => {
    expect(rootPattern.test(uri)).toBe(false);
    expect(subpathPattern.test(uri)).toBe(false);
  });
});
