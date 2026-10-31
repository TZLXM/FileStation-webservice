import { defineConfig, transformWithEsbuild } from 'vite';
import { readFile } from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeBasePath } from './src/lib/base-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = normalizeBasePath(process.env.FILESTATION_BASE || '/');
const basePrefix = base === '/' ? '' : base.slice(0, -1);

export default defineConfig({
  base,
  plugins: [react(), {
    name: 'asset-recovery-bootstrap',
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        // Inline classic script must run before any entry JS, preload or CSS.
        // Compile the same implementation tested by the recovery unit tests.
        const source = await readFile(path.join(__dirname, 'src/lib/asset-recovery.ts'), 'utf8');
        const { code } = await transformWithEsbuild(
          source.replace(/^export /gm, '')
            + '\nwindow.__assetRecoveryCleanup = installAssetRecovery();',
          'asset-recovery.ts',
          { loader: 'ts', format: 'iife', minify: true },
        );
        return html.replace('<head>', `<head><script data-asset-recovery>${code}</script>`);
      },
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      [`${basePrefix}/api`]: {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ...(basePrefix
          ? { rewrite: (requestPath: string) => requestPath.slice(basePrefix.length) }
          : {}),
      },
    },
  },
});
