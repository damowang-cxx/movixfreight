import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  // 仅开发服务器使用；生产环境仍由宿主机 Nginx 将 /api/ 转发给 NestJS。
  server: {
    host: '127.0.0.1',
    port: 3002,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
