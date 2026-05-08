/**
 * Production dashboard build for Electron (absolute API + WS; relative asset base).
 */

import { spawn } from 'bun';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dir, '..');
const DASHBOARD_DIR = join(ROOT_DIR, 'apps', 'dashboard');
const outDir = join(DASHBOARD_DIR, 'dist');

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

const apiBase = process.env.ELECTRON_VITE_API_BASE_URL ?? 'http://127.0.0.1:3001';
const wsUrl =
  process.env.ELECTRON_VITE_WS_URL ?? apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';

const proc = spawn({
  cmd: ['bun', 'run', 'build'],
  cwd: DASHBOARD_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=4096',
    VITE_ELECTRON: 'true',
    VITE_API_BASE_URL: apiBase,
    VITE_WS_URL: wsUrl,
  },
});

const exitCode = await proc.exited;
process.exit(exitCode);
