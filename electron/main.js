const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');

let win = null;
let tray = null;
let agent = null;
let baseUrl = null;
let quitting = false;

async function boot() {
  const { YouTubeAutomationAgent } = require('../index.js');
  agent = new YouTubeAutomationAgent();
  const info = await agent.start({ host: '127.0.0.1', port: Number(process.env.PORT) || 3456 });
  baseUrl = info.url;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    backgroundColor: '#14181b',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(baseUrl);

  // External links (e.g. YouTube URLs, docs) open in the system browser, not in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it — the scheduler keeps running in the tray
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('YouTube Automation Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => win.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => win.show());
}

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (error) {
    dialog.showErrorBox('Failed to start', error.message);
    app.quit();
    return;
  }
  createWindow();
  createTray();
});

app.on('before-quit', async (event) => {
  if (quitting === 'done') return;
  event.preventDefault();
  quitting = 'done';
  try {
    if (agent) await agent.shutdown();
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  // app.quit() re-enters the before-quit cycle, which is unreliable to call a
  // second time from an async continuation — app.exit() terminates the
  // process immediately, which is safe since shutdown() already cleaned up.
  app.exit(0);
});

app.on('window-all-closed', () => {
  // Intentionally not quitting — node-cron keeps scheduled generation/publishing
  // running from the tray even with no window open.
});

app.on('activate', () => {
  if (win) win.show();
});
