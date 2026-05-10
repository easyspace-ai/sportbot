/**
 * Idempotent electron binary install for workspace postinstall.
 * electron-builder runs `bun install` again during pack; re-running install.js
 * hits EEXIST on existing symlinks under Electron.app.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function main() {
  let electronDir;
  try {
    electronDir = dirname(require.resolve('electron/package.json'));
  } catch {
    return;
  }

  const pathTxt = join(electronDir, 'path.txt');
  if (existsSync(pathTxt)) {
    return;
  }

  const distDir = join(electronDir, 'dist');
  if (existsSync(distDir)) {
    console.warn('[postinstall] electron dist without path.txt — removing stale dist');
    rmSync(distDir, { recursive: true, force: true });
  }

  const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    cwd: electronDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.error) {
    throw r.error;
  }
  const code = r.status ?? 1;
  if (code !== 0) {
    process.exit(code);
  }
}

main();
