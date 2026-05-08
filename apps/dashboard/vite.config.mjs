import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Dev: proxy to bot API (default 3001). Set `VITE_DEV_API_ORIGIN` or `PORT` in `apps/bot/.env`. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiOrigin = env.VITE_DEV_API_ORIGIN || 'http://localhost:3001';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  const isProd = mode === 'production';
  const electronPack = env.VITE_ELECTRON === 'true';

  return {
    base: isProd && electronPack ? './' : isProd ? '/' : '/',
    plugins: [react()],
    server: {
      proxy: {
        '/api': apiOrigin,
        '/ws': { target: wsOrigin, ws: true },
      },
    },
  };
});
