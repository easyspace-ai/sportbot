import { join } from 'node:path';
import { app } from 'electron';

/**
 * Absolute path to bundled `preload.cjs` (next to `main.cjs` under `dist/`).
 * Must be resolved when creating `BrowserWindow` (after `app.whenReady()`): at
 * main-module load time `app.getAppPath()` can be wrong on some setups, which
 * breaks preload and leaves the renderer blank.
 */
export function getPreloadPath(): string {
  return join(app.getAppPath(), 'dist', 'preload.cjs');
}

/** Packaged dashboard static entry (extraResources → resources/dashboard). */
export function packagedDashboardIndexPath(): string {
  return join(process.resourcesPath, 'dashboard', 'index.html');
}

/** Monorepo root when running unpackaged from apps/electron. */
export function monorepoRootDev(): string {
  return join(app.getAppPath(), '..', '..');
}
