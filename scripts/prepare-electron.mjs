import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { workspaceBundlePlugin, readLicensePolicy } from './package-client.mjs';
import { API_VERSION } from '../shared/protocol.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const smokeRuntime = process.argv.includes('--smoke');
const out = path.join(root, 'artifacts', smokeRuntime ? 'electron-runtime-smoke' : 'electron-runtime');
const isDev = process.argv.includes('--dev') || smokeRuntime;
const keyFlag = process.argv.indexOf('--public-key');
const keyPath = path.resolve(keyFlag >= 0 ? process.argv[keyFlag + 1] : path.join(root, 'artifacts', 'issuer', 'public.pem'));

let policy;
if (!isDev) policy = await readLicensePolicy(keyPath);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await bundle({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  banner: { js: "import { createRequire as __lookCreateRequire } from 'node:module'; const require = __lookCreateRequire(import.meta.url);" },
  define: { __LOOK_IN_GIT_LICENSE_POLICY__: policy ? JSON.stringify(policy) : 'undefined' },
  external: ['vite'],
  plugins: [workspaceBundlePlugin(root)],
});
try { await cp(path.join(root, 'dist'), out, { recursive: true, force: true, errorOnExist: false }); }
catch { throw new Error('Frontend build is missing. Run npm run build before preparing the desktop package.'); }
if (!smokeRuntime) await promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'make-electron-icons.mjs')], { cwd: root, shell: false, windowsHide: true });
console.log(`Prepared Electron backend (API ${API_VERSION}) at ${out}`);
