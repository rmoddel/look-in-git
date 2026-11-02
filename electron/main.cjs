const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let backend;
let backendStopped = false;
let stopping = false;
let windowRef;

ipcMain.handle('look-in-git:select-directory', async event => {
  if (!windowRef || event.sender !== windowRef.webContents) throw new Error('Directory selection is available only to the Look-in-Git window.');
  const result = await dialog.showOpenDialog(windowRef, { title: 'Choose a parent folder for the new worktree', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

function backendRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.resolve(__dirname, '..', 'artifacts', 'electron-runtime');
}

async function startBackend() {
  backendStopped = false;
  const root = backendRoot();
  const serverFile = path.join(root, 'server.mjs');
  let readyPort;
  let readyBuffer = '';
  backend = spawn(process.execPath, [serverFile, '--prebuilt'], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOOK_IN_GIT_PORT: '0', LOOK_IN_GIT_READY_FD: '3' },
  });
  let logs = '';
  for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  backend.stdio[3].on('data', chunk => {
    readyBuffer = (readyBuffer + chunk.toString()).slice(-4096);
    for (const line of readyBuffer.split(/\r?\n/)) {
      try { const message = JSON.parse(line); if (message.type === 'ready' && Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535) readyPort = message.port; } catch { /* Wait for a complete control message. */ }
    }
  });
  backend.once('error', error => { logs += `\n${error.message}`; });
  backend.once('exit', () => { backendStopped = true; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (backendStopped) throw new Error(logs || 'The local Git service exited before it was ready.');
    if (readyPort) {
      const url = `http://127.0.0.1:${readyPort}`;
      try {
        const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(700) });
        if (response.ok) return url;
      } catch { /* The process announced its bound port; wait for HTTP to be ready. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`The local Git service did not start in time.\n${logs}`);
}

function stopBackend() {
  if (backend && !backendStopped) backend.kill('SIGTERM');
}

async function createWindow() {
  const url = await startBackend();
  windowRef = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    title: 'Look-in-Git',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) void shell.openExternal(target);
    return { action: 'deny' };
  });
  windowRef.webContents.on('will-navigate', (event, target) => {
    if (target !== url && !target.startsWith(`${url}/`)) event.preventDefault();
  });
  windowRef.on('closed', () => { windowRef = undefined; });
  await windowRef.loadURL(url);
}

app.whenReady().then(createWindow).catch(async error => {
  stopBackend();
  await dialog.showMessageBox({ type: 'error', title: 'Look-in-Git could not start', message: 'The local Git service could not start.', detail: error.message });
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on('before-quit', event => {
  if (!backend || backendStopped || stopping) return;
  event.preventDefault();
  stopping = true;
  backend.once('exit', () => { backendStopped = true; app.quit(); });
  stopBackend();
  setTimeout(() => { if (!backendStopped) { backend.kill(); app.quit(); } }, 2500).unref();
});
app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});
