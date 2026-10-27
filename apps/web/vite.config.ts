import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeBasePath } from './src/lib/base-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = normalizeBasePath(process.env.FILESTATION_BASE || '/');
const basePrefix = base === '/' ? '' : base.slice(0, -1);

export default defineConfig({
  base,
  plugins: [react()],
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
