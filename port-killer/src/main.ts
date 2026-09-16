import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
} from 'bunmaska';
import {
  killCommand,
  killProcess,
  knownService,
  listListeningPorts,
  isProtectedProcess,
} from './ports';

const assetDir = existsSync(join(import.meta.dir, 'index.html'))
  ? import.meta.dir
  : dirname(process.execPath);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const createWindow = (): void => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: 'Portkill',
    webPreferences: {
      preload: join(assetDir, 'preload.js'),
    },
  });

  mainWindow.loadFile(join(assetDir, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

ipcMain.handle('ports:list', async () => {
  const ports = await listListeningPorts();
  return ports.map((p) => ({
    ...p,
    service: knownService(p.port),
    protected: isProtectedProcess(p),
    self: p.pid === process.pid,
  }));
});

ipcMain.handle('ports:kill', async (_event, pid: number, force = false) => {
  return killProcess(pid, Boolean(force));
});

ipcMain.handle('ports:killCommand', (_event, pid: number, force = false) => {
  return killCommand(pid, Boolean(force));
});

ipcMain.handle('app:platform', () => process.platform);

ipcMain.handle('app:quit', () => {
  app.quit();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createWindow();
  });

  app.whenReady().then(() => {
    createWindow();

    try {
      tray = new Tray(join(assetDir, 'icon.png'));
      tray.setToolTip('Portkill — free stuck ports');
      // On macOS, a context menu consumes the tray click — menu is the interaction.
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Portkill', click: () => createWindow() },
          {
            label: 'Refresh',
            click: () => mainWindow?.webContents.send('ports:refresh'),
          },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ]),
      );
    } catch (err) {
      console.warn('Tray unavailable:', err);
    }

    const shortcut =
      process.platform === 'darwin' ? 'Command+Shift+K' : 'Control+Shift+K';
    try {
      globalShortcut.register(shortcut, () => createWindow());
    } catch (err) {
      console.warn('Global shortcut unavailable:', err);
    }
  });

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignore
    }
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray when possible.
    if (!tray) {
      app.quit();
    }
  });

  app.on('activate', () => {
    createWindow();
  });
}
