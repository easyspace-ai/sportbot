import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLogger } from './logger';

const log = createLogger('migrate');

/**
 * Applies pending Prisma migrations before the ORM connects so local / Electron DBs
 * never drift behind `schema.prisma` (missing tables like RiskTask).
 *
 * Skipped in Vitest (`NODE_ENV=test` / `VITEST`), or when `PRISMA_SKIP_MIGRATE_ON_BOOT=1`.
 */
export function runPendingMigrationsOrThrow(): void {
  if (process.env.PRISMA_SKIP_MIGRATE_ON_BOOT === '1') {
    log.warn('skipped (PRISMA_SKIP_MIGRATE_ON_BOOT=1)');
    return;
  }
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return;
  }

  const cwd = process.cwd();
  const schema = path.join(cwd, 'prisma', 'schema.prisma');
  if (!existsSync(schema)) {
    throw new Error(`[migrate] schema not found: ${schema}`);
  }

  const requireFromBot = createRequire(path.join(cwd, 'package.json'));
  let prismaCli: string;
  try {
    prismaCli = path.join(
      path.dirname(requireFromBot.resolve('prisma/package.json')),
      'build',
      'index.js',
    );
  } catch {
    throw new Error(
      '[migrate] `prisma` package not found — add it to dependencies for packaged builds (see electron resource staging).',
    );
  }
  if (!existsSync(prismaCli)) {
    throw new Error(`[migrate] CLI entry missing: ${prismaCli}`);
  }

  log.info('running prisma migrate deploy …');
  const r = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', schema],
    {
      cwd,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(`[migrate] prisma migrate deploy exited with code ${String(r.status)}`);
  }
  log.info('prisma migrate deploy finished');
}
