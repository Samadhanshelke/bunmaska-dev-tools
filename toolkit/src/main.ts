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
import {
  killCommand,
  killProcess,
  knownService,
  listListeningPorts,
  isProtectedProcess,
} from './ports';
import { scanRepo } from './git';
import { suggestCommits } from './suggest';
import { suggestCommitsWithGroq } from './ai';

const assetDir = existsSync(join(import.meta.dir, 'index.html'))
  ? import.meta.dir
  : dirname(process.execPath);

const stateDir = join(app.getPath('userData'), 'toolkit');
const recentPath = join(stateDir, 'recent.json');

type RecentState = {
  lastRepo?: string;
  lastTool?: 'ports' | 'commits';
  groqApiKey?: string;
};

function loadRecent(): RecentState {
  try {
    if (!existsSync(recentPath)) return {};
    return JSON.parse(readFileSync(recentPath, 'utf8')) as RecentState;
  } catch {
    return {};
  }
}

function saveRecent(patch: Partial<RecentState>): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(recentPath, JSON.stringify({ ...loadRecent(), ...patch }, null, 2));
  } catch (err) {
    console.warn('Could not persist state:', err);
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function publicPrefs() {
  const s = loadRecent();
  const key = s.groqApiKey?.trim() ?? '';
  return {
    lastRepo: s.lastRepo,
    lastTool: s.lastTool,
    hasGroqKey: Boolean(key),
    groqKeyMasked: key ? maskKey(key) : null,
  };
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const createWindow = (tool?: 'ports' | 'commits'): void => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (tool) mainWindow.webContents.send('app:navigate', tool);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 540,
    title: 'Toolkit',
    webPreferences: {
      preload: join(assetDir, 'preload.js'),
    },
  });

  mainWindow.loadFile(join(assetDir, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// —— Portkill ——
ipcMain.handle('ports:list', async () => {
  const ports = await listListeningPorts();
  return ports.map((p) => ({
    ...p,
    service: knownService(p.port, p.name, p.command),
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

// —— Commit Suggest ——
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

ipcMain.handle('repo:recent', () => loadRecent().lastRepo ?? null);

ipcMain.handle('repo:scan', async (_event, repoPath: string) => {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Repository path required.');
  }
  const scan = await scanRepo(repoPath);
  saveRecent({ lastRepo: scan.root });

  const apiKey = loadRecent().groqApiKey?.trim() ?? '';
  let groups;
  let suggestions;
  let source: 'ai' | 'heuristic' = 'heuristic';
  let model: string | undefined;
  let warning: string | undefined;

  if (apiKey && scan.files.length) {
    try {
      const ai = await suggestCommitsWithGroq(scan.files, apiKey);
      groups = ai.groups;
      suggestions = ai.suggestions;
      source = 'ai';
      model = ai.model;
    } catch (err) {
      const fallback = suggestCommits(scan.files);
      groups = fallback.groups;
      suggestions = fallback.suggestions;
      source = 'heuristic';
      warning = err instanceof Error ? err.message : String(err);
    }
  } else {
    const fallback = suggestCommits(scan.files);
    groups = fallback.groups;
    suggestions = fallback.suggestions;
    source = 'heuristic';
    if (!apiKey && scan.files.length) {
      warning = 'Add a free Groq API key for AI suggestions (Console → API Keys).';
    }
  }

  return {
    root: scan.root,
    branch: scan.branch,
    dirty: scan.dirty,
    fileCount: scan.files.length,
    source,
    model: model ?? null,
    warning: warning ?? null,
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

ipcMain.handle('clipboard:read', async () => {
  return clipboard.readText();
});

ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('app:prefs', () => publicPrefs());
ipcMain.handle('app:setTool', (_event, tool: 'ports' | 'commits') => {
  if (tool === 'ports' || tool === 'commits') saveRecent({ lastTool: tool });
  return true;
});

ipcMain.handle('app:setGroqKey', (_event, key: unknown) => {
  const value = String(key ?? '').trim();
  saveRecent({ groqApiKey: value || undefined });
  return publicPrefs();
});

ipcMain.handle('app:clearGroqKey', () => {
  const cur = loadRecent();
  delete cur.groqApiKey;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(recentPath, JSON.stringify(cur, null, 2));
  } catch (err) {
    console.warn('Could not clear API key:', err);
  }
  return publicPrefs();
});

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
    // Needed for Cmd/Ctrl+V (and cut/copy) inside inputs on macOS WebKit.
    try {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: 'View',
            submenu: [
              { label: 'Portkill', click: () => createWindow('ports') },
              { label: 'Commit Suggest', click: () => createWindow('commits') },
            ],
          },
          {
            label: 'Window',
            submenu: [{ role: 'minimize' }, { role: 'close' }],
          },
        ]),
      );
    } catch (err) {
      console.warn('Application menu unavailable:', err);
    }

    createWindow();

    try {
      tray = new Tray(join(assetDir, 'icon.png'));
      tray.setToolTip('Toolkit — ports & commit messages');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Toolkit', click: () => createWindow() },
          { label: 'Portkill', click: () => createWindow('ports') },
          { label: 'Commit Suggest', click: () => createWindow('commits') },
          { type: 'separator' },
          {
            label: 'Refresh ports',
            click: () => mainWindow?.webContents.send('ports:refresh'),
          },
          {
            label: 'Rescan repo',
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
      process.platform === 'darwin' ? 'Command+Shift+T' : 'Control+Shift+T';
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
