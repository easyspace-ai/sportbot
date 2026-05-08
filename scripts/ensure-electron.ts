/**
 * Bun may skip `electron`'s postinstall, so `path.txt` is never written.
 * Run `node node_modules/electron/install.js` once when the binary is missing.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function resolveElectronExecutable(): string {
  const pkgPath = require.resolve('electron/package.json');
  const electronDir = dirname(pkgPath);
  const pathTxt = join(electronDir, 'path.txt');
  if (!existsSync(pathTxt)) {
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
  return require('electron') as string;
}

if (import.meta.main) {
  console.log(resolveElectronExecutable());
}
