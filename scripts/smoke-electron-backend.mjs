import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL(process.argv.includes('--smoke') ? '../artifacts/electron-runtime-smoke/' : '../artifacts/electron-runtime/', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'look-in-git-desktop-smoke-'));
const child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--prebuilt'], {
  cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOOK_IN_GIT_PORT: '0', LOOK_IN_GIT_READY_FD: '3', LOOK_IN_GIT_DISCOVERY_ROOT: directory },
});
try {
  let readyBuffer = '', port, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
  child.stdio[3].on('data', chunk => {
    readyBuffer = (readyBuffer + chunk.toString()).slice(-4096);
    for (const line of readyBuffer.split(/\r?\n/)) {
      try { const message = JSON.parse(line); if (message.type === 'ready') port = message.port; } catch { /* Wait for a complete control message. */ }
    }
  });
  let session;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Bundled backend exited early (${child.exitCode}).\n${stderr}`);
    if (port) try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { session = await response.json(); break; }
    } catch { /* Backend is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!session) throw new Error('Bundled backend did not answer on loopback.');
  const homepage = await fetch(`http://127.0.0.1:${port}/`);
  const html = await homepage.text();
  if (!homepage.ok || !html.includes('<div id="root">')) throw new Error(`Bundled desktop frontend did not load (HTTP ${homepage.status}).`);
  const protocol = await import('../shared/protocol.ts');
  if (session.apiVersion !== protocol.API_VERSION || typeof session.token !== 'string') throw new Error('Bundled backend returned an incompatible session.');
  console.log(`Bundled desktop backend is ready on loopback (API ${session.apiVersion}).`);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) child.kill();
  }
  await rm(directory, { recursive: true, force: true });
}
