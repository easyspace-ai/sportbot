# Electron shell

- **Main** `src/main/index.ts`: picks a free port (dev prefers `3001`), spawns `apps/bot` (`bun --watch` in dev, `ELECTRON_RUN_AS_NODE` + `dist/index.js` when packaged), waits on `/api/health`, then loads the UI.
- **Dev UI**: `VITE_DEV_SERVER_URL` (default `http://localhost:5173`) — Vite dev server for `apps/dashboard`.
- **Packaged UI**: static files from `resources/dashboard/` (`loadFile` + `file:` URL). API/WS use `http://127.0.0.1:3001` (see `scripts/electron-build-renderer.ts` env).
- **Preload** `src/preload/preload.ts`: `window.shell` sample API.

Build from repo root: `bun run electron:build` then `bun run electron:dist` (see root `package.json`).

Packaging config: [electron-builder.yml](./electron-builder.yml).
