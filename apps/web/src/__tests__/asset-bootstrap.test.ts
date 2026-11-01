// @vitest-environment node
import { build } from 'vite';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('built shell recovery before entry evaluation', () => {
  it.each(['/', '/fs/'])('recovers missing entry/style at %s without evaluating the module graph', async (base) => {
    const result = await build({ base, logLevel: 'silent', build: { write: false } });
    const bundle = Array.isArray(result) ? result[0] : result;
    if (!('output' in bundle)) throw new Error('Expected bundle');
    const html = bundle.output.find((file) => file.fileName === 'index.html');
    if (!html || html.type !== 'asset') throw new Error('Expected shell');
    const shell = String(html.source);
    const match = /<script data-asset-recovery>([\s\S]*?)<\/script>/.exec(shell);
    expect(match).not.toBeNull();
    expect(shell.indexOf('data-asset-recovery')).toBeLessThan(shell.indexOf('type="module"'));
    expect(shell.indexOf('data-asset-recovery')).toBeLessThan(shell.indexOf('rel="stylesheet"'));
    const entry = /<script type="module"[^>]*src="([^"]+)"/.exec(shell)![1];
    const style = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(shell)![1];
    expect(entry.startsWith(`${base}assets/`)).toBe(true);
    expect(style.startsWith(`${base}assets/`)).toBe(true);
    const reload = vi.fn();
    const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' });
    const window = dom.window as Window & typeof globalThis;
    const { document, sessionStorage } = window;
    const target = {
      document, sessionStorage, location: { reload },
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
    };
    // Execute only the shipped classic bootstrap, never the entry module.
    const installCode = new Function('window', 'Element', `${match![1]}; return window.__assetRecoveryCleanup;`);
    const install = (targetWindow: typeof target) => installCode(targetWindow, window.Element);
    for (const [tag, url] of [['script', entry], ['link', style]]) {
      sessionStorage.clear();
      reload.mockClear();
      const cleanup = install(target);
      const asset = document.createElement(tag);
      asset.setAttribute(tag === 'script' ? 'src' : 'href', url);
      document.body.append(asset);
      asset.dispatchEvent(new window.Event('error'));
      expect(reload).toHaveBeenCalledTimes(1);
      cleanup();
      const nextCleanup = install(target);
      asset.dispatchEvent(new window.Event('error'));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('页面资源加载失败');
      nextCleanup();
      document.body.innerHTML = '';
    }
    dom.window.close();
  }, 30_000);
});
