/**
 * Optional pre-pack housekeeping (craft-agents-oss style entrypoint).
 *
 * PolyBot ships backend + dashboard via monorepo `bun run electron:build:resources`
 * (see `scripts/electron-build-resources.ts`). This script only ensures
 * `apps/electron/build/` exists for electron-builder `directories.buildResources`
 * and any optional files (e.g. `build/Assets.car` for afterPack.cjs).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ELECTRON_DIR = join(import.meta.dir, '..');
const BUILD_DIR = join(ELECTRON_DIR, 'build');

mkdirSync(BUILD_DIR, { recursive: true });
console.log('[copy-assets] ensured', BUILD_DIR);
console.log('[copy-assets] run from repo root: bun run electron:build:resources');
