/**
 * Dev: esbuild main + preload, dashboard Vite, Electron (VITE_DEV_SERVER_URL).
 * Bot is started by Electron main (bun --watch in apps/bot).
 */

import { spawnSync } from 'node:child_process';
import { spawn } from 'bun';
import { existsSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { resolveElectronExecutable } from './ensure-electron';

const ROOT_DIR = join(import.meta.dir, '..');
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron');
const DIST_DIR = join(ELECTRON_DIR, 'dist');
const electronPath = resolveElectronExecutable();

const vitePort = process.env.VITE_PORT || '5173';
const viteUrl = `http://localhost:${vitePort}`;

async function run(cmd: string[], cwd: string): Promise<number> {
  const p = spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' });
  return p.exited;
}

function copyResources(): void {
  const src = join(ELECTRON_DIR, 'resources');
  const dest = join(DIST_DIR, 'resources');
  if (!existsSync(src)) {
    return;
  }
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(DIST_DIR, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('resources → dist/resources');
}

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

function runBunBuild(entry: string, outfile: string): void {
  const r = spawnSync(
    'bun',
    ['build', entry, '--outfile', outfile, '--target', 'node', '--format', 'cjs', '--external', 'electron'],
    { stdio: 'inherit', cwd: ROOT_DIR },
  );
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

runBunBuild(join(ELECTRON_DIR, 'src/main/index.ts'), join(DIST_DIR, 'main.cjs'));
runBunBuild(join(ELECTRON_DIR, 'src/preload/preload.ts'), join(DIST_DIR, 'preload.cjs'));

copyResources();

const viteProc = spawn({
  cmd: [
    'bun',
    'x',
    'vite',
    'dev',
    '--config',
    'vite.config.mjs',
    '--strict-port',
    '--port',
    vitePort,
  ],
  cwd: join(ROOT_DIR, 'apps', 'dashboard'),
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
});

await new Promise((r) => setTimeout(r, 1500));

const electronProc = spawn({
  cmd: [electronPath, '.'],
  cwd: ELECTRON_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: viteUrl,
  },
});

let exiting = false;
function stopVite(): void {
  try {
    viteProc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

function exitAll(c: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  stopVite();
  process.exit(c);
}

void electronProc.exited.then((c) => exitAll(c ?? 0));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopVite();
    try {
      electronProc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    exitAll(0);
  });
}
