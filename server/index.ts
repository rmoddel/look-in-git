import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, writeSync } from 'node:fs';
import { createApp, errorHandler } from './app.js';
import { discover, Repositories } from './repositories.js';
import { createLicenseManager, type LicensePolicy } from './licensing.js';
import { git } from './git.js';

// The distributor embeds this literal at build time. Client command-line flags
// and environment variables cannot turn a licensed bundle into a dev build.
declare const __LOOK_IN_GIT_LICENSE_POLICY__: LicensePolicy | undefined;
const policy = typeof __LOOK_IN_GIT_LICENSE_POLICY__ === 'undefined' ? undefined : __LOOK_IN_GIT_LICENSE_POLICY__;
const license = policy ? await createLicenseManager(policy) : undefined;

const projectRoot = process.cwd();
const development = !policy && process.argv.includes('--dev');
const prebuilt = process.argv.includes('--prebuilt');
const port = Number(process.env.LOOK_IN_GIT_PORT ?? '4317');
if (!Number.isInteger(port) || port < (prebuilt ? 0 : 1024) || port > 65535) throw new Error('LOOK_IN_GIT_PORT must be 0 (desktop automatic selection) or between 1024 and 65535.');
try { await git(projectRoot, '--version', []); }
catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'GIT_NOT_FOUND') throw new Error('Git is required to run Look-in-Git. Install Git for Windows or Git for macOS, make sure `git` is available on PATH, then restart the app.');
  throw error;
}
const discoveryRoot = process.env.LOOK_IN_GIT_DISCOVERY_ROOT ?? path.join(homedir(), 'code');
const repositories = new Repositories();
const initial = process.env.LOOK_IN_GIT_REPO;
if (initial) await repositories.open(initial);
try {
  const result = await discover(discoveryRoot);
  for (const root of result.roots) {
    try { await repositories.open(root); } catch { /* One inaccessible project should not block the app. */ }
  }
  console.log(`Look-in-Git: discovered ${result.roots.length} repositories in ${discoveryRoot}${result.truncated ? ' (scan limit reached)' : ''}.`);
} catch { console.log(`Look-in-Git: ${discoveryRoot} is unavailable. Add a local repository in the app.`); }
const { app, origin } = createApp({ port, repositories, discoveryRoot, license });
const server = createServer(app);
if (development) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root: projectRoot, configLoader: 'runner', server: { middlewareMode: true, hmr: { server, host: '127.0.0.1' } }, appType: 'spa' });
  app.use(vite.middlewares);
  server.on('close', () => { void vite.close(); });
} else {
  if (!policy && !process.argv.includes('--prebuilt')) {
    const { build } = await import('vite');
    await build({ root: projectRoot, configLoader: 'runner' });
  }
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  // Desktop preparation copies the built UI directly beside the bundled server
  // (the backend directory is also its cwd). Normal installs use projectRoot/dist.
  const frontendRoot = prebuilt && existsSync(path.join(projectRoot, 'index.html')) ? projectRoot : path.join(projectRoot, 'dist');
  app.use(express.static(frontendRoot, { etag: false, lastModified: false }));
}
app.use(errorHandler);
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other app or set LOOK_IN_GIT_PORT.` : error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : port;
  console.log(`\n  Look-in-Git\n  http://127.0.0.1:${activePort}\n  Local Git workspace\n`);
  if (prebuilt && process.env.LOOK_IN_GIT_READY_FD === '3') {
    writeSync(3, `${JSON.stringify({ type: 'ready', port: activePort })}\n`);
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
