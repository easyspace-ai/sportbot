import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { monorepoRootDev } from './paths';

const isDev = !app.isPackaged;

const defaultBackendHost = '127.0.0.1';
const packagedBackendPort = 7633;
const portRangeStart = Number.parseInt(process.env.BACKEND_PORT_MIN ?? '16543', 10);
const portRangeEnd = Number.parseInt(process.env.BACKEND_PORT_MAX ?? '17000', 10);

let backendProc: ChildProcess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveBackendCwd(): Promise<string> {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend');
  }
  return join(monorepoRootDev(), 'apps', 'bot');
}

function defaultDatabaseUrl(dataDir: string): string {
  const file = join(dataDir, 'app.db');
  const normalized = file.replace(/\\/g, '/');
  return `file:${normalized}`;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, defaultBackendHost);
  });
}

export async function pickBackendPort(): Promise<number> {
  const fixed = process.env.BACKEND_PORT?.trim() ?? process.env.PORT?.trim();
  if (fixed) {
    const parsed = Number.parseInt(fixed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    throw new Error(`invalid fixed backend port: ${fixed}`);
  }

  if (isDev) {
    if (await isPortAvailable(packagedBackendPort)) {
      return packagedBackendPort;
    }
  }

  if (app.isPackaged) {
    if (await isPortAvailable(packagedBackendPort)) {
      return packagedBackendPort;
    }
    throw new Error(`packaged app needs port ${packagedBackendPort} free (or set BACKEND_PORT)`);
  }

  for (let p = portRangeStart; p <= portRangeEnd; p += 1) {
    if (await isPortAvailable(p)) {
      return p;
    }
  }
  throw new Error(`no available backend port in range ${portRangeStart}-${portRangeEnd}`);
}

export async function waitForBackendReady(url: string, timeoutMs = 30000): Promise<void> {
  const healthUrl = new URL('/api/health', url);
  const deadline = Date.now() + timeoutMs;

  const pingHealth = async (): Promise<boolean> => {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          protocol: healthUrl.protocol,
          hostname: healthUrl.hostname,
          port: healthUrl.port,
          path: healthUrl.pathname,
          method: 'GET',
          timeout: 1500,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve();
            return;
          }
          reject(new Error(`health status ${String(res.statusCode)}`));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    return true;
  };

  while (Date.now() < deadline) {
    try {
      if (await pingHealth()) {
        return;
      }
    } catch {
      // backend may still be starting.
    }
    await sleep(500);
  }
  throw new Error(`backend health check timeout: ${healthUrl.toString()}`);
}

export async function startBackend(): Promise<void> {
  if (backendProc) {
    return;
  }

  const cwd = await resolveBackendCwd();
  const port = process.env.PORT;
  if (!port) {
    throw new Error('PORT is not set before startBackend');
  }

  const dataDir = join(app.getPath('userData'), 'PolyBot', 'data');
  await mkdir(dataDir, { recursive: true });

  const databaseUrl = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl(dataDir);

  console.info(`[electron] bot cwd: ${cwd}`);
  console.info(`[electron] data dir: ${dataDir}`);

  if (app.isPackaged) {
    const entry = join(cwd, 'dist', 'index.js');
    await access(entry);
    backendProc = spawn(process.execPath, [entry], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: port,
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
      },
    });
  } else {
    await access(join(cwd, 'src', 'index.ts'));
    backendProc = spawn('bun', ['--watch', 'src/index.ts'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PORT: port,
        DATABASE_URL: process.env.DATABASE_URL?.trim() || databaseUrl,
      },
    });
  }

  backendProc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[bot] ${String(chunk)}`);
  });
  backendProc.stderr?.on('data', (chunk) => {
    process.stderr.write(`[bot] ${String(chunk)}`);
  });

  backendProc.on('exit', (code, signal) => {
    console.error(`[bot] exited code=${String(code)} signal=${String(signal)}`);
    backendProc = null;
  });
}

export function stopBackend(): void {
  if (!backendProc || backendProc.killed) {
    return;
  }
  try {
    backendProc.kill('SIGTERM');
  } catch {
    // no-op
  }
}

export const backendConstants = {
  defaultBackendHost,
} as const;
