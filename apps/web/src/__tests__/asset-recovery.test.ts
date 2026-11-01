// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_RECOVERY_KEY,
  installAssetRecovery,
} from '../lib/asset-recovery';

function appendAsset(tag: 'script' | 'link', url: string): HTMLElement {
  const element = document.createElement(tag);
  if (tag === 'script') {
    (element as HTMLScriptElement).src = url;
  } else {
    (element as HTMLLinkElement).rel = 'stylesheet';
    (element as HTMLLinkElement).href = url;
  }
  document.body.appendChild(element);
  return element;
}

describe('asset recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  it.each([
    ['script', '/assets/app-0123456789ab.js'],
    ['link', '/fs/assets/app-0123456789ab.css'],
  ] as const)('reloads once for a missing hashed %s asset', (tag, url) => {
    const reload = vi.fn();
    const showError = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: sessionStorage,
      reload,
      showError,
    });
    const asset = appendAsset(tag, url);

    asset.dispatchEvent(new Event('error'));
    asset.dispatchEvent(new Event('error'));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ASSET_RECOVERY_KEY)).toBe('1');
    cleanup();
  });

  it('shows a recoverable error when the guarded reload fails again', () => {
    sessionStorage.setItem(ASSET_RECOVERY_KEY, '1');
    const reload = vi.fn();
    const showError = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: sessionStorage,
      reload,
      showError,
    });
    const asset = appendAsset('script', '/assets/app-0123456789ab.js');

    asset.dispatchEvent(new Event('error'));

    expect(reload).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toMatchObject({
      title: '页面资源加载失败',
    });
    expect(showError.mock.calls[0][1]).toEqual(expect.any(Function));

    const retry = showError.mock.calls[0][1] as () => void;
    retry();
    expect(sessionStorage.getItem(ASSET_RECOVERY_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does not reload for unrelated runtime errors', () => {
    const reload = vi.fn();
    const showError = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: sessionStorage,
      reload,
      showError,
    });
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'Unrelated application error',
      error: new Error('Unrelated application error'),
    }));

    expect(reload).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    cleanup();
  });

  it('handles Vite dynamic-import failures through the same one-shot guard', () => {
    const reload = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: sessionStorage,
      reload,
    });
    const event = new Event('vite:preloadError');

    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does not reload when session storage is unavailable because the guard cannot be persisted', () => {
    const reload = vi.fn();
    const showError = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage disabled');
        },
        removeItem: () => undefined,
      },
      reload,
      showError,
    });
    const asset = appendAsset('script', '/assets/app-0123456789ab.js');

    asset.dispatchEvent(new Event('error'));

    expect(reload).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('removes every listener during cleanup', () => {
    const reload = vi.fn();
    const showError = vi.fn();
    const cleanup = installAssetRecovery({
      window,
      storage: sessionStorage,
      reload,
      showError,
    });
    cleanup();
    const asset = appendAsset('script', '/assets/app-0123456789ab.js');

    asset.dispatchEvent(new Event('error'));
    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});
