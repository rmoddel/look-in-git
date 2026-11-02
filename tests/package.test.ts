import { afterAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
// The packager intentionally runs as standalone Node JavaScript without compilation.
// @ts-expect-error The standalone build script has no TypeScript declaration file.
import { archiveRelease, collectThirdPartyNotices, launcherPowerShell, parseArguments, readLicensePolicy, verifyRelease, workspaceBundlePlugin, writeReleaseManifest } from '../scripts/package-client.mjs';

const execute = promisify(execFile), cleanup: string[] = [];
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'look-in-git-package-test-')); cleanup.push(root); return root; }
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
afterAll(async () => {
  const tempRoot = await realpath(os.tmpdir());
  for (const root of cleanup) {
    const actual = await realpath(root), relative = path.relative(tempRoot, actual);
    if ((await lstat(root)).isSymbolicLink() || path.isAbsolute(relative) || relative.includes(path.sep) || !/^look-in-git-package-test-[a-z0-9]+$/i.test(relative)) throw new Error('Refusing to remove a non-package-test directory.');
    await rm(actual, { recursive: true, force: true });
  }
});

describe('portable client release packaging', () => {
  it('requires complete runtime/license options and rejects unknown arguments', () => {
    expect(parseArguments([]).publicKey).toMatch(/artifacts[\\/]issuer[\\/]public\.pem$/);
    expect(() => parseArguments(['--node-runtime', 'node.exe'])).toThrow('both');
    expect(() => parseArguments(['--node-license', 'LICENSE'])).toThrow('both');
    expect(() => parseArguments(['--skip-license'])).toThrow('Unknown');
    expect(() => parseArguments(['--public-key'])).toThrow('incomplete');
  });

  it('accepts only an Ed25519 public verifier and never embeds a private key', async () => {
    const root = await temporary(), { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicFile = path.join(root, 'public.pem'), privateFile = path.join(root, 'private.pem');
    await writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
    await writeFile(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const policy = await readLicensePolicy(publicFile);
    expect(policy).toMatchObject({ productId: 'look-in-git', trialDays: 30 });
    expect(policy.publicKey).toBe(publicKey.export({ type: 'spki', format: 'pem' }));
    await expect(readLicensePolicy(privateFile)).rejects.toThrow('Private issuer keys');
    await expect(readLicensePolicy(path.join(root, 'absent.pem'))).rejects.toThrow('required');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(publicFile, rsa.publicKey.export({ type: 'spki', format: 'pem' }));
    await expect(readLicensePolicy(publicFile)).rejects.toThrow('Ed25519');
  });

  it('detects modified, missing and unexpected release files using the manifest', async () => {
    const root = await temporary(); await mkdir(path.join(root, 'app'));
    await writeFile(path.join(root, 'app', 'server.mjs'), 'export const version = "test";\n');
    const manifest = await writeReleaseManifest(root, { version: '0.0.0-test' });
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ path: 'app/server.mjs', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(verifyRelease(root)).resolves.toMatchObject({ version: '0.0.0-test' });
    await writeFile(path.join(root, 'app', 'server.mjs'), 'changed');
    await expect(verifyRelease(root)).rejects.toThrow('integrity');
    await writeFile(path.join(root, 'app', 'server.mjs'), 'export const version = "test";\n');
    await writeFile(path.join(root, 'unexpected.txt'), 'not in manifest');
    await expect(verifyRelease(root)).rejects.toThrow('integrity');
    // This second manifest has an intentionally missing entry, not a deletion of
    // any application or fixture source.
    manifest.files.push({ path: 'missing.txt', bytes: 1, sha256: '0'.repeat(64) });
    await writeFile(path.join(root, 'manifest.sha256.json'), JSON.stringify(manifest));
    await expect(verifyRelease(root)).rejects.toThrow('integrity');
  });

  it('includes full installed runtime dependency licenses without development toolchains', async () => {
    const root = await temporary(), packages = await collectThirdPartyNotices(path.join(root, 'licenses'));
    const names = packages.map((item: { name: string }) => item.name);
    for (const name of ['express', 'router', 'react', 'react-dom', 'scheduler', 'highlight.js', 'lucide-react', 'tailwindcss']) expect(names).toContain(name);
    for (const name of ['vite', 'typescript', 'vitest', 'esbuild']) expect(names).not.toContain(name);
    for (const item of packages) {
      expect(item.files.length).toBeGreaterThan(0);
      for (const file of item.files) expect((await readFile(path.join(root, 'licenses', file), 'utf8')).length).toBeGreaterThan(100);
    }
  });

  it.runIf(process.platform === 'win32')('produces a PowerShell launcher that parses without errors', async () => {
    const root = await temporary(), launcher = path.join(root, 'Start-Look-in-Git.ps1'), parser = path.join(root, 'parse.ps1');
    await writeFile(launcher, launcherPowerShell(123));
    await writeFile(parser, 'param([string]$Target)\n$tokens = $null; $errors = $null\n[void][System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$tokens, [ref]$errors)\nif ($errors.Count) { throw ($errors.Message -join "`n") }\n');
    await expect(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', parser, '-Target', launcher], { shell: false, windowsHide: true })).resolves.toBeDefined();
  });

  it.runIf(process.platform === 'win32')('launches when multiple Git applications are present on PATH', async () => {
    const root = await temporary(), launcher = path.join(root, 'Start-Look-in-Git.ps1');
    const first = path.join(root, 'first'), second = path.join(root, 'second');
    await mkdir(first); await mkdir(second); await mkdir(path.join(root, 'app'));
    // Native executable fixtures reproduce Get-Command's array result without
    // touching any installed Git executable or invoking repository operations.
    for (const folder of [first, second]) {
      try { await link(process.execPath, path.join(folder, 'git.exe')); }
      catch { await copyFile(process.execPath, path.join(folder, 'git.exe')); }
    }
    await writeFile(launcher, launcherPowerShell(123));
    await writeFile(path.join(root, 'app', 'server.mjs'), 'console.log("LAUNCHER_SMOKE_OK");');
    const probe = path.join(root, 'probe.ps1');
    await writeFile(probe, 'param([string]$Launcher)\nif (@(Get-Command git.exe -CommandType Application).Count -lt 2) { throw "Expected multiple native Git command matches" }\n& $Launcher -NoBrowser\nexit $LASTEXITCODE\n');
    const env: NodeJS.ProcessEnv = { ...process.env, LOOK_IN_GIT_PORT: String(await freePort()) };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
    env[pathKey] = [first, second, env[pathKey]].join(path.delimiter);
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, '-Launcher', launcher], { env, shell: false, windowsHide: true, timeout: 20000 });
    expect(result.stdout).toContain('LAUNCHER_SMOKE_OK');
  });

  it('bundles and boots the real server with the workspace resolver and immutable license policy', async () => {
    const root = await temporary(), app = path.join(root, 'app'), discovery = path.join(root, 'empty-discovery');
    await mkdir(app); await mkdir(discovery); await mkdir(path.join(app, 'dist'));
    await writeFile(path.join(app, 'dist', 'index.html'), '<!doctype html><title>Release smoke fixture</title>');
    const { publicKey } = generateKeyPairSync('ed25519');
    const policy = { productId: 'look-in-git', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), trialDays: 30 };
    const result = await build({
      entryPoints: [path.resolve('server/index.ts')], absWorkingDir: process.cwd(), bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
      plugins: [workspaceBundlePlugin()], tsconfigRaw: {}, external: ['vite'], logLevel: 'silent',
      define: { __LOOK_IN_GIT_LICENSE_POLICY__: JSON.stringify(policy) },
      banner: { js: "import { createRequire as __lookCreateRequire } from 'node:module'; const require = __lookCreateRequire(import.meta.url);" },
    });
    await writeFile(path.join(app, 'server.mjs'), result.outputFiles[0].contents);
    const port = await freePort(), env: NodeJS.ProcessEnv = { ...process.env, LOOK_IN_GIT_PORT: String(port), LOOK_IN_GIT_DISCOVERY_ROOT: discovery, LOCALAPPDATA: path.join(root, 'state') };
    delete env.LOOK_IN_GIT_REPO;
    const child = spawn(process.execPath, ['server.mjs', '--prebuilt', '--dev'], { cwd: app, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors += data.toString(); });
    const stopped = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
      let session: { license: { mode: string; allowed: boolean; daysRemaining: number } } | undefined;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (child.exitCode !== null) throw new Error('Bundled server exited: ' + errors);
        try { session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      expect(session, errors).toBeDefined();
      expect(session!.license).toMatchObject({ mode: 'trial', allowed: true, daysRemaining: 30 });
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally { child.kill('SIGTERM'); await stopped; }
  });

  it.runIf(process.platform === 'win32')('creates a ZIP with literal paths and refuses to overwrite an existing release', async () => {
    const root = await temporary(), source = path.join(root, 'release with spaces [1]'), archive = path.join(root, 'client.zip');
    await mkdir(source); await mkdir(path.join(source, 'app'));
    await writeFile(path.join(source, 'app', 'server.mjs'), 'console.log("fixture");');
    await writeFile(path.join(source, 'QuickStart.txt'), 'Disposable ZIP test');
    await archiveRelease(source, archive);
    expect((await lstat(archive)).size).toBeGreaterThan(50);
    const inspect = path.join(root, 'inspect.ps1');
    await writeFile(inspect, 'param([string]$Archive)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)\ntry { @($zip.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $zip.Dispose() }\n');
    const entries = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', inspect, '-Archive', archive], { shell: false, windowsHide: true })).stdout) as string[];
    expect(entries.map(entry => entry.replace(/\\/g, '/'))).toContain('release with spaces [1]/app/server.mjs');
    await expect(archiveRelease(source, archive)).rejects.toThrow('overwritten');
  });
});
