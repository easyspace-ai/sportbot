/**
 * Bundle preload → apps/electron/dist/preload.cjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_DIR = join(import.meta.dir, '..');
const DIST_DIR = join(ROOT_DIR, 'apps/electron/dist');

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

const entry = join(ROOT_DIR, 'apps/electron/src/preload/preload.ts');
const outfile = join(DIST_DIR, 'preload.cjs');

const r = spawnSync(
  'bun',
  ['build', entry, '--outfile', outfile, '--target', 'node', '--format', 'cjs', '--external', 'electron'],
  { stdio: 'inherit', cwd: ROOT_DIR },
);

if (r.status !== 0) {
  console.error('preload build failed:', r.status);
  process.exit(r.status ?? 1);
}
console.log('preload.cjs ok');
