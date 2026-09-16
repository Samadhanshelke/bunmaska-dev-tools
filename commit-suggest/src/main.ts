import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  dialog,
  clipboard,
} from 'bunmaska';
import { scanRepo } from './git';
import { suggestCommits } from './suggest';

const assetDir = existsSync(join(import.meta.dir, 'index.html'))
  ? import.meta.dir
  : dirname(process.execPath);

const stateDir = join(app.getPath('userData'), 'commit-suggest');
const recentPath = join(stateDir, 'recent.json');

type RecentState = { lastRepo?: string };

function loadRecent(): RecentState {
  try {
    if (!existsSync(recentPath)) return {};
    return JSON.parse(readFileSync(recentPath, 'utf8')) as RecentState;
  } catch {
    return {};
  }
}

function saveRecent(state: RecentState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(recentPath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('Could not persist recent repo:', err);
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const createWindow = (): void => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'Commit Suggest',
    webPreferences: {
      preload: join(assetDir, 'preload.js'),
    },
  });

  mainWindow.loadFile(join(assetDir, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

ipcMain.handle('repo:pick', async () => {
  const recent = loadRecent();
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: recent.lastRepo,
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true as const };
  }
  const root = result.filePaths[0];
  saveRecent({ lastRepo: root });
  return { canceled: false as const, path: root };
});

ipcMain.handle('repo:recent', () => {
  return loadRecent().lastRepo ?? null;
});

ipcMain.handle('repo:scan', async (_event, repoPath: string) => {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Repository path required.');
  }
  const scan = await scanRepo(repoPath);
  saveRecent({ lastRepo: scan.root });
  const { groups, suggestions } = suggestCommits(scan.files);
  return {
    root: scan.root,
    branch: scan.branch,
    dirty: scan.dirty,
    fileCount: scan.files.length,
    groups: groups.map((g) => ({
      id: g.id,
      label: g.label,
      additions: g.additions,
      deletions: g.deletions,
      files: g.files.map((f) => ({
        path: f.path,
        status: f.status,
        staged: f.staged,
        additions: f.additions,
        deletions: f.deletions,
      })),
    })),
    suggestions,
  };
});

ipcMain.handle('clipboard:write', (_event, text: string) => {
  clipboard.writeText(String(text ?? ''));
  return true;
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
      tray.setToolTip('Commit Suggest — message ideas from your diff');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Commit Suggest', click: () => createWindow() },
          {
            label: 'Rescan',
            click: () => mainWindow?.webContents.send('repo:refresh'),
          },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ]),
      );
    } catch (err) {
      console.warn('Tray unavailable:', err);
    }

    const shortcut =
      process.platform === 'darwin' ? 'Command+Shift+M' : 'Control+Shift+M';
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
    if (!tray) {
      app.quit();
    }
  });

  app.on('activate', () => {
    createWindow();
  });
}
