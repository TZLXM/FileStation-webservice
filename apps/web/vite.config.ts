import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 子路径部署支持：构建时用 --base 或环境变量 FILESTATION_BASE 指定
  // 例如部署在 https://tools.tzlxm.top/fs/ 下：npm run build -- --base=/fs/
  base: process.env.FILESTATION_BASE || '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
