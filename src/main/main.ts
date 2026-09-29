import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWindowBounds } from './bounds';
import { getAlwaysOnTop, getHotkey, getWindowBounds, setHotkeyRegistered, setWindowBounds } from './store';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;

// ---------- Crash logging ----------
// Without these handlers an uncaught error in main kills the whole app — in
// the middle of an interview — with nothing on disk to explain why. Every
// pipeline error this app expects already flows through structured AppError
// events; anything landing here is a bug, so log it and keep the app alive
// (each question runs its own session, so surviving is safe: the worst case is
// one failed answer, and the next Record press starts clean).
function logFatal(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const line = `${new Date().toISOString()} [${kind}] ${detail}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
  } catch {
    // Logging must never crash the logger.
  }
  try {
    console.error(line.trimEnd());
  } catch {}
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

function sendToWindow(channel: string): void {
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel);
}

/**
 * (Re)register the global shortcut from the stored hotkey and record what
 * actually happened. Registration is not guaranteed: `register` returns false
 * when another app already owns the accelerator, and throws when the
 * accelerator string is malformed. Either way the user is told the truth
 * instead of pressing a key that does nothing.
 */
function applyHotkey(): void {
  globalShortcut.unregisterAll();
  const hotkey = getHotkey();
  if (!hotkey) {
    setHotkeyRegistered(false); // deliberately disabled, not a failure
    return;
  }
  let registered = false;
  try {
    registered = globalShortcut.register(hotkey, () => sendToWindow('hotkey:toggle'));
  } catch {
    registered = false; // malformed accelerator
  }
  setHotkeyRegistered(registered);
}

function createWindow(): void {
  // Reopen where the user left the window; drop the position (Electron then
  // centers) if the display it was on is gone.
  const bounds = sanitizeWindowBounds(
    getWindowBounds(),
    screen.getAllDisplays().map((d) => d.workArea),
    { width: 460, height: 700 },
    { width: 380, height: 520 },
  );

  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    title: 'AI Call Assistant',
    autoHideMenuBar: true,
    alwaysOnTop: getAlwaysOnTop(),
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches contextBridge/ipcRenderer, both available in
      // sandboxed preloads — so the renderer (which renders model output) gets
      // the full Chromium sandbox.
      sandbox: true,
    },
  });

  // Hide the window from screen sharing / screen recording (WDA_EXCLUDEFROMCAPTURE).
  win.setContentProtection(true);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // External links (e.g. "get API key") open in the default browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // A crashed renderer otherwise leaves a frozen window that looks like a hang.
  // Reload it once per cool-down; a renderer that dies instantly on every load
  // stops being retried instead of flickering forever.
  let lastRendererReload = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    logFatal('render-process-gone', new Error(details.reason));
    const now = Date.now();
    if (now - lastRendererReload > 10_000 && win && !win.webContents.isDestroyed()) {
      lastRendererReload = now;
      win.webContents.reload();
    }
  });

  // Persist geometry as the user drags (debounced), and flush on close.
  // 'close' alone is not enough: a renderer-initiated window.close() — and a
  // killed process — never fire it, only 'closed', by which point the window
  // is destroyed and its bounds unreadable. The debounced save is what makes
  // those paths (and crashes) keep the geometry anyway.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = (): void => {
    boundsTimer = null;
    if (win && !win.isDestroyed()) setWindowBounds(win.getNormalBounds());
  };
  const queueBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', queueBoundsSave);
  win.on('move', queueBoundsSave);

  win.on('close', () => {
    // getNormalBounds: when closed maximized, save the restored geometry
    // rather than pinning the next launch to a full-screen-sized window.
    if (boundsTimer) clearTimeout(boundsTimer);
    saveBounds();
  });

  win.on('closed', () => {
    // A pending debounce must not fire against a destroyed window.
    if (boundsTimer) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    win = null;
  });
}

// One instance only: a second copy would fight the first for the global
// shortcut and clobber its settings.json writes. The second launch defers to
// the running instance, which surfaces its window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Route getDisplayMedia to Windows system-audio loopback so the app can hear
    // whatever the call application is playing, without any screen picker UI.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        // thumbnailSize 0: only `audio: 'loopback'` is wanted here, and the
        // renderer stops the video track immediately. Left at the default this
        // screenshots every display on each Record press — pure latency on the
        // one path the user is waiting on.
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback(null as never));
    });

    registerIpc(() => win, applyHotkey);
    createWindow();
    applyHotkey();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Global shortcuts outlive the window; releasing them is what lets the user's
// next app (or the next run of this one) claim the accelerator.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
