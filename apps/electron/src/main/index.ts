import { loadShellEnv } from './shell-env';

loadShellEnv();

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { sanitizePackagedEnv } from './env-sanitize';
import { createAppWindow } from './app-window';
import {
  backendConstants,
  pickBackendPort,
  startBackend,
  stopBackend,
  waitForBackendReady,
} from './backend-spawn';

sanitizePackagedEnv(app);

ipcMain.handle('app:ping', () => 'pong');

function openMainWindow(): void {
  createAppWindow();
}

app
  .whenReady()
  .then(async () => {
    const selectedPort = await pickBackendPort();
    process.env.PORT = String(selectedPort);
    process.env.POLYBACKEND_PORT = process.env.POLYBACKEND_PORT ?? String(selectedPort);
    const backendUrl =
      process.env.BACKEND_URL?.trim() ||
      `http://${backendConstants.defaultBackendHost}:${selectedPort}`;

    await startBackend();
    await waitForBackendReady(backendUrl);
    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openMainWindow();
      }
    });
  })
  .catch((err: unknown) => {
    console.error('electron startup failed', err);
    const detail =
      err instanceof Error
        ? `${err.message}\n\n配置已内置在 apps/bot/src/embeddedEnv.ts（打包前请写入真实 SX_BET_API_KEY 等）。查看终端 [bot] 日志排查后端是否崩溃。`
        : String(err);
    try {
      dialog.showErrorBox('PolyBot 无法启动', detail.slice(0, 3500));
    } catch {
      /* ignore */
    }
    app.quit();
  });

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});
