import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Force the public-mode flag so Vite picks it up via import.meta.env.VITE_PUBLIC_MODE
process.env.VITE_PUBLIC_MODE = 'true';

/** Same as main dev config — proxy to the bot API (default port 3001). */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiOrigin = env.VITE_DEV_API_ORIGIN || 'http://localhost:3001';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');

  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        '/api': apiOrigin,
        '/ws': { target: wsOrigin, ws: true },
      },
    },
    build: {
      outDir: 'dist-public',
    },
  };
});
