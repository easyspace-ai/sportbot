import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Must match `PORT` in `bot/.env` (default 3001). Override with `VITE_DEV_API_ORIGIN`. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiOrigin = env.VITE_DEV_API_ORIGIN || 'http://localhost:3001';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': apiOrigin,
        '/ws': { target: wsOrigin, ws: true },
      },
    },
  };
});
