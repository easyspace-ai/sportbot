import type { App } from 'electron';

/**
 * Strip Vite dev variables in packaged builds so a developer machine env
 * cannot point production at localhost.
 */
export function sanitizePackagedEnv(app: App): void {
  if (!app.isPackaged) {
    return;
  }
  delete process.env.VITE_DEV_SERVER_URL;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VITE_')) {
      delete process.env[key];
    }
  }
}
