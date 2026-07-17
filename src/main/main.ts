import { app, BrowserWindow, desktopCapturer, globalShortcut, session, shell } from 'electron';
import path from 'node:path';
import { getAlwaysOnTop, getHotkey, setHotkeyRegistered } from './store';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;

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
  win = new BrowserWindow({
    width: 460,
    height: 700,
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
      sandbox: false,
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

  win.on('closed', () => {
    win = null;
  });
}

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

// Global shortcuts outlive the window; releasing them is what lets the user's
// next app (or the next run of this one) claim the accelerator.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
