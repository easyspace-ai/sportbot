/**
 * Unified dev server for the Electron app (craft-agents-oss style):
 * Vite runs from `apps/electron` but `root` is `apps/dashboard` so the real UI
 * stays in the dashboard package; proxy `/api` + `/ws` to the bot.
 *
 * Standalone dashboard dev still uses `apps/dashboard/vite.config.mjs` — keep
 * proxy defaults in sync when you change ports or origins.
 */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, '..', 'dashboard');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, dashboardRoot, '');
  const apiOrigin = env.VITE_DEV_API_ORIGIN || 'http://127.0.0.1:7633';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  const isProd = mode === 'production';
  const electronPack = env.VITE_ELECTRON === 'true';

  return {
    root: dashboardRoot,
    base: isProd && electronPack ? './' : isProd ? '/' : '/',
    plugins: [react()],
    server: {
      /** Must match `waitForViteReady` / `VITE_DEV_SERVER_URL` (127.0.0.1). Default `localhost` often binds ::1 only → fetch 127.0.0.1 fails → black window. */
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      open: false,
      proxy: {
        '/api': apiOrigin,
        '/ws': { target: wsOrigin, ws: true },
      },
    },
    build: {
      outDir: join(dashboardRoot, 'dist'),
      emptyDirBeforeWrite: true,
    },
  };
});
