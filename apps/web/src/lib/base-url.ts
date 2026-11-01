const EXTERNAL_URL = /^[a-z][a-z\d+.-]*:/i;

function assertInternalPath(value: string, label: string): void {
  if (value.includes('\\') || value.startsWith('//') || EXTERNAL_URL.test(value)) {
    throw new Error(`${label} must be an internal absolute path, not an external absolute URL`);
  }
}

function normalizePathname(pathname: string, label: string): string {
  assertInternalPath(pathname, label);

  const hasTrailingSlash = pathname.endsWith('/');
  const segments = pathname.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new Error(`${label} cannot contain parent-directory segments`);
  }

  const normalized = `/${segments.join('/')}`;
  return hasTrailingSlash && normalized !== '/' ? `${normalized}/` : normalized;
}

function splitSuffix(path: string): { pathname: string; suffix: string } {
  const suffixIndex = path.search(/[?#]/);
  return suffixIndex === -1
    ? { pathname: path, suffix: '' }
    : { pathname: path.slice(0, suffixIndex), suffix: path.slice(suffixIndex) };
}

export function normalizeBasePath(baseUrl: string): string {
  if (/[?#]/.test(baseUrl)) {
    throw new Error('The deployment base must be a path without a query or fragment');
  }
  assertInternalPath(baseUrl, 'The deployment base');

  const normalized = normalizePathname(
    baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`,
    'The deployment base',
  );
  return normalized === '/' ? '/' : `${normalized.replace(/\/$/, '')}/`;
}

export function withBasePath(path: string): string {
  const { pathname, suffix } = splitSuffix(path);
  assertInternalPath(path, 'An application path');
  const base = normalizeBasePath(import.meta.env.BASE_URL);
  const normalizedPath = normalizePathname(pathname, 'An application path');

  if (base === '/') {
    return `${normalizedPath}${suffix}`;
  }
  if (normalizedPath === '/') {
    return `${base}${suffix}`;
  }
  return `${base.slice(0, -1)}${normalizedPath}${suffix}`;
}

export function absoluteAppUrl(path: string): string {
  const appPath = withBasePath(path);
  return `${window.location.origin}${appPath}`;
}

export function apiPath(path: string): string {
  assertInternalPath(path, 'An API path');
  return withBasePath(`/api/v1${path}`);
}

export function routerBasename(): string {
  return normalizeBasePath(import.meta.env.BASE_URL).replace(/\/$/, '') || '/';
}
