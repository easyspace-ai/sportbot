/**
 * Assemble Electron extraResources: dashboard static + portable bot backend.
 */

import { existsSync, mkdirSync, cpSync, rmSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'bun';

const ROOT_DIR = join(import.meta.dir, '..');
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron');
const DASHBOARD_DIST = join(ROOT_DIR, 'apps', 'dashboard', 'dist');
const BOT_DIR = join(ROOT_DIR, 'apps', 'bot');
const CLOB_DIR = join(ROOT_DIR, 'packages', 'clob-client-v2');
const RESOURCES_DIR = join(ELECTRON_DIR, 'resources');
const BACKEND_DIR = join(RESOURCES_DIR, 'backend');
const DASHBOARD_OUT = join(RESOURCES_DIR, 'dashboard');

function run(cmd: string[], cwd: string): Promise<number> {
  const p = spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' });
  return p.exited;
}

async function main(): Promise<void> {
  if (!existsSync(DASHBOARD_DIST)) {
    console.error('Missing apps/dashboard/dist — run electron:build:renderer first');
    process.exit(1);
  }

  if (existsSync(RESOURCES_DIR)) {
    rmSync(RESOURCES_DIR, { recursive: true, force: true });
  }
  mkdirSync(DASHBOARD_OUT, { recursive: true });

  cpSync(DASHBOARD_DIST, DASHBOARD_OUT, { recursive: true });
  console.log('dashboard dist → resources/dashboard');

  const code = await run(['bun', 'run', 'build'], CLOB_DIR);
  if (code !== 0) {
    process.exit(code);
  }

  const codeBot = await run(['bun', 'run', 'build'], BOT_DIR);
  if (codeBot !== 0) {
    process.exit(codeBot);
  }

  const botPkg = JSON.parse(readFileSync(join(BOT_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...(botPkg.dependencies ?? {}) } as Record<string, string>;
  deps['@polymarket/clob-client-v2'] = 'file:./vendor/clob-client-v2';
  const prismaVer = botPkg.devDependencies?.prisma;
  if (prismaVer) {
    deps.prisma = prismaVer;
  }

  const staging = join(ELECTRON_DIR, '.backend-staging');
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });

  cpSync(join(BOT_DIR, 'dist'), join(staging, 'dist'), { recursive: true });
  cpSync(join(BOT_DIR, 'prisma'), join(staging, 'prisma'), { recursive: true });
  const schemaPath = join(staging, 'prisma', 'schema.prisma');
  const schemaText = readFileSync(schemaPath, 'utf8');
  writeFileSync(
    schemaPath,
    schemaText.replace(/output\s*=\s*"[^"]+"/, 'output   = "../node_modules/.prisma/client"'),
  );

  mkdirSync(join(staging, 'vendor', 'clob-client-v2'), { recursive: true });
  cpSync(join(CLOB_DIR, 'dist'), join(staging, 'vendor', 'clob-client-v2', 'dist'), {
    recursive: true,
  });
  cpSync(join(CLOB_DIR, 'package.json'), join(staging, 'vendor', 'clob-client-v2', 'package.json'));

  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: 'polybot-backend-bundle',
        private: true,
        scripts: {
          start: 'node dist/index.js',
        },
        dependencies: deps,
      },
      null,
      2,
    ) + '\n',
  );

  const installCode = await run(['bun', 'install', '--production', '--ignore-scripts'], staging);
  if (installCode !== 0) {
    process.exit(installCode);
  }

  const prismaGen = await run(
    ['bun', 'x', 'prisma', 'generate', '--schema', 'prisma/schema.prisma'],
    staging,
  );
  if (prismaGen !== 0) {
    process.exit(prismaGen);
  }

  if (existsSync(BACKEND_DIR)) {
    rmSync(BACKEND_DIR, { recursive: true, force: true });
  }
  renameSync(staging, BACKEND_DIR);

  console.log('backend bundle → resources/backend');
}

await main();
