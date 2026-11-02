import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:net';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(projectRoot);
try {
  const port = Number(process.env.LOOK_IN_GIT_PORT ?? '4317');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LOOK_IN_GIT_PORT must be between 1024 and 65535.');
  // Check before rebuilding shared output. A second startup must not replace
  // the UI underneath an older server that still owns this port.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use. Stop the running Look-in-Git terminal with Ctrl+C, then run npm.cmd start again. Nothing was rebuilt.`) : error));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
  await promisify(execFile)(process.execPath, [path.join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.server.json'], { cwd: projectRoot, shell: false, windowsHide: true });
  if (process.argv.includes('--demo')) await import('../dist-server/scripts/demo.js');
  else await import('../dist-server/server/index.js');
} catch (error) {
  console.error('Look-in-Git could not start.');
  console.error(error.stdout || error.stderr || error.message);
  process.exitCode = 1;
}
