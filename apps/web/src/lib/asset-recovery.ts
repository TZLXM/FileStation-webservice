export const ASSET_RECOVERY_KEY = 'filestation.asset-recovery.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AssetRecoveryError {
  title: string;
  message: string;
}

interface AssetRecoveryOptions {
  window?: Window;
  storage?: StorageLike;
  reload?: () => void;
  showError?: (error: AssetRecoveryError, retry: () => void) => void;
}

const HASHED_ASSET_PATH =
  /\/assets\/[^/?#]+-[a-z0-9_-]{8,}\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|ico|wasm)(?:[?#]|$)/i;
const CHUNK_FAILURE =
  /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|chunkloaderror|loading chunk/i;

function hasHashedAssetPath(value: unknown): boolean {
  return typeof value === 'string' && HASHED_ASSET_PATH.test(value);
}

function missingAssetEvent(event: Event): boolean {
  if (event.type === 'vite:preloadError') return true;

  const element = event.target instanceof Element ? event.target : null;
  if (element?.tagName === 'SCRIPT') {
    return hasHashedAssetPath(element.getAttribute('src'));
  }
  if (element?.tagName === 'LINK') {
    return hasHashedAssetPath(element.getAttribute('href'));
  }

  if (event.type === 'error') {
    const errorEvent = event as ErrorEvent;
    const reason = errorEvent.error instanceof Error ? errorEvent.error.message : '';
    return hasHashedAssetPath(errorEvent.message) || CHUNK_FAILURE.test(reason);
  }

  const reason = (event as Event & { reason?: unknown }).reason;
  return reason instanceof Error && CHUNK_FAILURE.test(reason.message);
}

function showDefaultError(
  target: Window,
  error: AssetRecoveryError,
  retry: () => void,
): void {
  target.document.getElementById('asset-recovery-error')?.remove();
  const panel = target.document.createElement('div');
  panel.id = 'asset-recovery-error';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'asset-recovery-title');
  Object.assign(panel.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'rgba(17, 24, 39, 0.72)',
  });

  const card = target.document.createElement('div');
  Object.assign(card.style, {
    width: 'min(100%, 520px)',
    borderRadius: '12px',
    background: 'white',
    padding: '24px',
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.3)',
  });

  const title = target.document.createElement('h1');
  title.id = 'asset-recovery-title';
  title.textContent = error.title;
  title.style.fontSize = '20px';
  title.style.fontWeight = '700';
  title.style.marginBottom = '12px';

  const message = target.document.createElement('p');
  message.textContent = error.message;
  message.style.marginBottom = '18px';

  const button = target.document.createElement('button');
  button.type = 'button';
  button.textContent = '重新加载';
  button.addEventListener('click', retry);
  Object.assign(button.style, {
    border: '0',
    borderRadius: '6px',
    background: '#2563eb',
    color: 'white',
    padding: '10px 16px',
    cursor: 'pointer',
  });

  card.append(title, message, button);
  panel.append(card);
  // A stylesheet can fail while the HTML parser is still in <head>.
  (target.document.body ?? target.document.documentElement).append(panel);
}

export function installAssetRecovery(
  options: AssetRecoveryOptions = {},
): () => void {
  const target =
    options.window ?? (typeof window === 'undefined' ? undefined : window);
  if (!target) return () => undefined;

  const reload = options.reload ?? (() => target.location.reload());
  const showError = options.showError ?? ((error, retry) => {
    showDefaultError(target, error, retry);
  });
  const recoverableError = {
    title: '页面资源加载失败',
    message: '更新后的页面资源没有加载成功。请检查连接后重试；若问题持续，请刷新页面或重新部署前端资源。',
  };
  let triggered = false;

  const storage = (): StorageLike | undefined => {
    if (options.storage) return options.storage;
    try {
      return target.sessionStorage;
    } catch {
      return undefined;
    }
  };

  const retry = () => {
    try {
      storage()?.removeItem(ASSET_RECOVERY_KEY);
    } finally {
      reload();
    }
  };

  const recover = (event: Event) => {
    if (triggered || !missingAssetEvent(event)) return;
    triggered = true;
    if (typeof (event as Event & { preventDefault?: () => void }).preventDefault === 'function') {
      event.preventDefault();
    }

    const session = storage();
    if (!session) {
      showError(recoverableError, retry);
      return;
    }
    try {
      if (session.getItem(ASSET_RECOVERY_KEY)) {
        showError(recoverableError, retry);
        return;
      }
      session.setItem(ASSET_RECOVERY_KEY, '1');
      reload();
    } catch {
      showError(recoverableError, retry);
    }
  };

  target.addEventListener('error', recover, true);
  target.addEventListener('vite:preloadError', recover);
  target.addEventListener('unhandledrejection', recover);
  return () => {
    target.removeEventListener('error', recover, true);
    target.removeEventListener('vite:preloadError', recover);
    target.removeEventListener('unhandledrejection', recover);
  };
}
