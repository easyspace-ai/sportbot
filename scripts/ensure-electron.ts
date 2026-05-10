/**
 * Resolve the Electron CLI binary for the **current** OS.
 *
 * `electron/path.txt` can point at the wrong platform (e.g. `electron.exe` on macOS)
 * after a bad install or cross-platform `node_modules` copy — `require('electron')` would
 * then return an unusable path (ENOEXEC on darwin). Prefer the real binary under `dist/`.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { platform } from 'node:os';

const require = createRequire(import.meta.url);

function platformBinaryInDist(distDir: string): string | null {
  if (platform() === 'darwin') {
    const p = join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    return existsSync(p) ? p : null;
  }
  if (platform() === 'win32') {
    const p = join(distDir, 'electron.exe');
    return existsSync(p) ? p : null;
  }
  const p = join(distDir, 'electron');
  return existsSync(p) ? p : null;
}

/** Rewrite path.txt so other tools (and `require('electron')`) match this platform. */
function syncPathTxt(electronDir: string, distDir: string, absoluteBinary: string): void {
  const rel = relative(distDir, absoluteBinary).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return;
  const pathTxt = join(electronDir, 'path.txt');
  try {
    writeFileSync(pathTxt, `${rel}\n`);
  } catch {
    /* ignore */
  }
}

export function resolveElectronExecutable(): string {
  const pkgPath = require.resolve('electron/package.json');
  const electronDir = dirname(pkgPath);
  const distDir = join(electronDir, 'dist');

  const direct = platformBinaryInDist(distDir);
  if (direct) {
    syncPathTxt(electronDir, distDir, direct);
    return direct;
  }

  const pathTxt = join(electronDir, 'path.txt');
  if (!existsSync(pathTxt)) {
    if (existsSync(distDir)) {
      console.warn('[electron] Stale/incomplete dist without usable binary — removing before install …');
      rmSync(distDir, { recursive: true, force: true });
    }
    console.log('[electron] Binary missing — running node_modules/electron/install.js …');
    const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
      cwd: electronDir,
      stdio: 'inherit',
      env: process.env,
    });
    if (r.error) {
      throw r.error;
    }
    if ((r.status ?? 1) !== 0) {
      throw new Error(`electron install.js exited with code ${String(r.status)}`);
    }
  }

  const after = platformBinaryInDist(distDir);
  if (after) {
    syncPathTxt(electronDir, distDir, after);
    return after;
  }

  return require('electron') as string;
}

if (import.meta.main) {
  console.log(resolveElectronExecutable());
}
