# Electron app

Integrated desktop shell (aligned with **craft-agents-oss** `apps/electron`): **main + preload** live here; **Vite dev** runs from this package with `root` = [`apps/dashboard`](../dashboard); the **bot** is still [`apps/bot`](../bot) and is spawned by the main process.

## Process layout

- **Main** ([index.ts](./src/main/index.ts)): sanitizes `VITE_*` env when packaged, picks a backend port, spawns `apps/bot`, waits on `/api/health`, opens a `BrowserWindow` via [app-window.ts](./src/main/app-window.ts).
- **Paths** ([paths.ts](./src/main/paths.ts)): `getPreloadPath()` resolves `dist/preload.cjs` after `app.whenReady()`; packaged dashboard HTML under `process.resourcesPath/dashboard/`.
- **Backend** ([backend-spawn.ts](./src/main/backend-spawn.ts)): dev `bun --watch`, packaged `ELECTRON_RUN_AS_NODE` + `dist/index.js` in `resources/backend/`.
- **Preload** ([preload.ts](./src/preload/preload.ts)): exposes `window.shell` (sample `ping` + `platform`).
- **Vite** ([vite.config.mjs](./vite.config.mjs)): dev server cwd is `apps/electron`; **`root`** points at `apps/dashboard` so one config owns the Electron dev URL + proxy to the bot.

## Dev vs prod

- **Dev**: `bun run electron:dev` from repo root (or `bun run dev` in this package) builds main/preload, starts Vite here, then Electron with `VITE_DEV_SERVER_URL` (default `http://127.0.0.1:5173`). Bot listens on `127.0.0.1` — proxy target uses `VITE_DEV_API_ORIGIN` in `apps/dashboard/.env.development` (prefer `127.0.0.1`, not `localhost`, on macOS).
- **Packaged**: `loadFile` on `extraResources/dashboard/index.html` (see [`electron-builder.yml`](./electron-builder.yml)). API/WebSocket URLs are baked at dashboard build time via `scripts/electron-build-renderer.ts` (`VITE_API_BASE_URL`, `VITE_WS_URL`).

## Standalone dashboard (no Electron)

From repo: `bun run --filter dashboard dev` — still uses `apps/dashboard/vite.config.mjs` (keep proxy defaults in sync with `apps/electron/vite.config.mjs`).

## Builds

From repo root: `bun run electron:build` then `bun run electron:dist` (see root [`package.json`](../../package.json)).

Packaging: [`electron-builder.yml`](./electron-builder.yml).

### Scripts (craft-style, under [`scripts/`](./scripts/))

| Script | Purpose |
|--------|--------|
| [`build-dmg.sh`](./scripts/build-dmg.sh) | macOS: `bun install` → `electron:build` → `electron-builder` with [`electron-builder.mac.yml`](./electron-builder.mac.yml). Optional: `source` repo root `.env` for signing vars. Root: `bun run electron:pack:mac` |
| [`build-linux.sh`](./scripts/build-linux.sh) | Linux AppImage via root `electron:pack:linux` |
| [`build-win.ps1`](./scripts/build-win.ps1) | Windows NSIS via root `electron:pack:win` |
| [`afterPack.cjs`](./scripts/afterPack.cjs) | `electron-builder` hook; copies optional `build/Assets.car` into the `.app` (same idea as craft). |
| [`copy-assets.ts`](./scripts/copy-assets.ts) | Ensures `build/` exists; backend+dashboard bundles still come from `bun run electron:build:resources` at repo root. Root: `bun run electron:copy-assets` |

Craft’s scripts also download Bun/Codex, upload to S3, etc. — those are **not** copied; PolyBot stays on the existing resource pipeline only.
