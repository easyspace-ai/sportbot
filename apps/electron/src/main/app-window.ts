import { BrowserWindow, Menu, app, shell } from 'electron';
import { release } from 'node:os';
import { getPreloadPath, packagedDashboardIndexPath } from './paths';

function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const buildNumber = Number.parseInt(release().split('.')[2] || '0', 10);
  if (buildNumber >= 22000) {
    return 'mica';
  }
  if (buildNumber >= 17763) {
    return 'acrylic';
  }
  return undefined;
}

function isAllowedNavigationUrl(url: string, devBase: string | undefined): boolean {
  if (url.startsWith('file:')) {
    return true;
  }
  if (devBase && url.startsWith(devBase)) {
    return true;
  }
  return false;
}

export function createAppWindow(): BrowserWindow {
  const devServerUrl = app.isPackaged
    ? undefined
    : (process.env.VITE_DEV_SERVER_URL?.trim() || 'http://127.0.0.1:5173');

  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const windowsBackgroundMaterial = getWindowsBackgroundMaterial();

  const preloadAbs = getPreloadPath();
  if (!app.isPackaged) {
    console.info(`[electron] preload → ${preloadAbs}`);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: '',
    /** Dev: solid background — macOS `vibrancy` ignores `backgroundColor` and stays black until paint. */
    ...(!app.isPackaged && { backgroundColor: '#09090b' }),
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 16 },
      ...(app.isPackaged
        ? {
            vibrancy: 'under-window',
            visualEffectState: 'active',
          }
        : {}),
    }),
    ...(isWindows && {
      frame: true,
      autoHideMenuBar: true,
      ...(windowsBackgroundMaterial && { backgroundMaterial: windowsBackgroundMaterial }),
    }),
    ...(!isMac && !isWindows && {
      frame: true,
      autoHideMenuBar: true,
    }),
    webPreferences: {
      preload: preloadAbs,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url, devServerUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (!app.isPackaged) {
    win.webContents.on('context-menu', (_event, params) => {
      Menu.buildFromTemplate([
        { label: 'Inspect Element', click: () => win.webContents.inspectElement(params.x, params.y) },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      ]).popup();
    });
  }

  if (app.isPackaged) {
    void win.loadFile(packagedDashboardIndexPath());
  } else {
    const devUrl = devServerUrl!;
    let failLoadRetries = 0;
    const loadDev = (): void => {
      void win.loadURL(devUrl);
    };
    win.webContents.on('did-fail-load', (_event, code, desc, validatedURL) => {
      if (!validatedURL.startsWith(devUrl)) {
        return;
      }
      console.error(`[electron] did-fail-load code=${String(code)} desc=${String(desc)} url=${validatedURL}`);
      if (failLoadRetries < 5) {
        failLoadRetries += 1;
        console.warn(`[electron] renderer load failed, retry ${failLoadRetries}/5 in 1s…`);
        setTimeout(loadDev, 1000);
      }
    });
    loadDev();
  }

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}
