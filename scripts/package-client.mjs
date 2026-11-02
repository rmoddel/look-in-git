import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const minimumNode = '22.12.0';
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Resolve/read only the known workspace through Node. Native esbuild otherwise
// enumerates drive ancestors while searching package metadata; managed Windows
// environments can prohibit that even though every required source is readable.
export function workspaceBundlePlugin(root = projectRoot) {
  return {
    name: 'look-in-git-workspace-files',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.path === 'vite' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true };
        const importer = args.importer || path.join(root, 'package.json');
        const require = createRequire(importer);
        let resolved;
        if (args.kind === 'entry-point') resolved = path.resolve(root, args.path);
        else {
          try { resolved = require.resolve(args.path); }
          catch (error) {
            if (!args.path.startsWith('.')) {
              let current = path.dirname(importer);
              while (current !== path.dirname(current)) {
                try {
                  const metadata = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
                  if (args.kind === 'require-call' && (metadata.peerDependenciesMeta?.[args.path]?.optional || Object.hasOwn(metadata.optionalDependencies ?? {}, args.path))) return { path: args.path, namespace: 'look-in-git-missing-optional' };
                  break;
                } catch { current = path.dirname(current); }
              }
              throw error;
            }
            const base = path.resolve(path.dirname(importer), args.path);
            const candidates = /\.js$/.test(base) ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx'] : [base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')];
            for (const candidate of candidates) { try { if ((await lstat(candidate)).isFile()) { resolved = candidate; break; } } catch { /* Continue through source extensions. */ } }
            if (!resolved) throw error;
          }
        }
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`A bundled dependency resolved outside this project: ${args.path}`);
        return { path: resolved, namespace: 'look-in-git-bundle' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'look-in-git-bundle' }, async args => {
        const extension = path.extname(args.path), loaders = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.json': 'json' };
        if (!loaders[extension]) throw new Error(`Unsupported server bundle file type: ${extension}`);
        return { contents: await readFile(args.path, 'utf8'), loader: loaders[extension] };
      });
      builder.onLoad({ filter: /.*/, namespace: 'look-in-git-missing-optional' }, args => ({
        contents: `const error = new Error(${JSON.stringify('Cannot find optional dependency: ')} + ${JSON.stringify(args.path)}); error.code = 'MODULE_NOT_FOUND'; throw error;`, loader: 'js',
      }));
    },
  };
}

export function parseArguments(argv) {
  const options = { publicKey: path.join(projectRoot, 'artifacts', 'issuer', 'public.pem') };
  const keys = { '--public-key': 'publicKey', '--node-runtime': 'nodeRuntime', '--node-license': 'nodeLicense' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') { options.help = true; continue; }
    if (!Object.hasOwn(keys, flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete packaging option: ${flag}`);
    if (Object.hasOwn(options, keys[flag]) && flag !== '--public-key') throw new Error(`Repeated packaging option: ${flag}`);
    options[keys[flag]] = path.resolve(argv[++i]);
  }
  if (!!options.nodeRuntime !== !!options.nodeLicense) throw new Error('Bundling Node requires both --node-runtime and --node-license. Supply the official LICENSE from the exact Node distribution being bundled.');
  return options;
}

export async function readLicensePolicy(publicKeyFile) {
  let pem;
  try { pem = (await readFile(publicKeyFile, 'utf8')).trim(); }
  catch { throw new Error(`Issuer public key is required: ${publicKeyFile}. Initialize your issuer keys first. A release without license enforcement will not be packaged.`); }
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----$/.test(pem) || /PRIVATE KEY/.test(pem)) throw new Error('The packaging key must contain only an Ed25519 public key in PEM format. Private issuer keys must never enter a client release.');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The issuer public key must use Ed25519.');
  return { productId: 'look-in-git', publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), trialDays: 30 };
}

export function launcherPowerShell(apiVersion) {
  if (!Number.isInteger(apiVersion)) throw new Error('A numeric API version is required.');
  return `param([switch]$OpenWhenReady, [switch]$NoBrowser, [ValidateRange(1024,65535)][int]$Port = 4317)
$ErrorActionPreference = 'Stop'
if ($OpenWhenReady) {
  $url = 'http://127.0.0.1:' + $Port
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try {
      $session = Invoke-RestMethod -Uri ($url + '/api/session') -TimeoutSec 1
      if ($session.apiVersion -eq ${apiVersion} -and $session.token) { Start-Process -FilePath $url; exit 0 }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  exit 1
}
$browserWaiter = $null
try {
  $appRoot = Join-Path $PSScriptRoot 'app'
  $bundledNode = Join-Path $PSScriptRoot 'runtime\\node.exe'
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
  else {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$nodeCommand) { throw 'Node.js 22.12 or newer is required. Install Node.js LTS from https://nodejs.org, then run this launcher again. No npm install is needed.' }
    $nodePath = $nodeCommand.Source
  }
  $nodeVersion = (& $nodePath --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\\d+)\\.(\\d+)\\.(\\d+)$') { throw 'Node.js could not be started.' }
  if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 12)) { throw ('Node.js 22.12 or newer is required; found ' + $nodeVersion) }
  $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$gitCommand) { throw 'Git for Windows is required. Install it from https://git-scm.com/download/win with command-line access enabled, then run this launcher again.' }
  & $gitCommand.Source --version
  if ($LASTEXITCODE -ne 0) { throw 'Git could not be started. Check your Git for Windows installation.' }
  if ($env:LOOK_IN_GIT_PORT) {
    $parsedPort = 0
    if (![int]::TryParse($env:LOOK_IN_GIT_PORT, [ref]$parsedPort) -or $parsedPort -lt 1024 -or $parsedPort -gt 65535) { throw 'LOOK_IN_GIT_PORT must be a number from 1024 through 65535.' }
    $Port = $parsedPort
  }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start() } catch { throw ('Port ' + $Port + ' is already in use. Close the existing Look-in-Git window or choose another LOOK_IN_GIT_PORT.') } finally { $listener.Stop() }
  $env:LOOK_IN_GIT_PORT = [string]$Port
  if (!$NoBrowser) {
    $powershellPath = Join-Path $PSHOME 'powershell.exe'
    if (!(Test-Path -LiteralPath $powershellPath)) { $powershellPath = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source }
    $browserWaiter = Start-Process -FilePath $powershellPath -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-OpenWhenReady', '-Port', [string]$Port) -WindowStyle Hidden -PassThru
  }
  Write-Host ''
  Write-Host 'Look-in-Git - local Git workspace' -ForegroundColor Cyan
  Write-Host ('Opening http://127.0.0.1:' + $Port)
  Write-Host 'Keep this window open. Press Ctrl+C to stop Look-in-Git.'
  Write-Host ''
  Push-Location -LiteralPath $appRoot
  try { & $nodePath 'server.mjs' '--prebuilt'; $serverExit = $LASTEXITCODE } finally { Pop-Location }
  if ($serverExit -ne 0) { throw ('Look-in-Git stopped with exit code ' + $serverExit + '. Review the message above.') }
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if ($browserWaiter -and !$browserWaiter.HasExited) { Stop-Process -InputObject $browserWaiter -ErrorAction SilentlyContinue }
}
`;
}

export async function collectThirdPartyNotices(destination, bundledPackageRoots = []) {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const pending = [...Object.keys(packageJson.dependencies), 'tailwindcss'].map(name => ({ name, from: projectRoot }));
  for (const root of bundledPackageRoots) {
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    pending.push({ name: metadata.name, from: root, exactRoot: root });
  }
  const seen = new Set(), packages = [];
  await mkdir(destination, { recursive: true });
  while (pending.length) {
    const { name, from, exactRoot } = pending.shift();
    const require = createRequire(path.join(from, 'package.json'));
    let packageFile = exactRoot ? path.join(exactRoot, 'package.json') : undefined;
    for (const base of packageFile ? [] : require.resolve.paths(name) ?? []) {
      const candidate = path.join(base, name, 'package.json');
      try { await lstat(candidate); packageFile = candidate; break; } catch { /* Try the next installed module location. */ }
    }
    if (!packageFile) throw new Error(`Cannot locate installed runtime dependency ${name}. Run npm.cmd install before packaging.`);
    const packageRoot = path.dirname(packageFile), metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    const identity = `${metadata.name}@${metadata.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const names = (await readdir(packageRoot)).filter(file => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file));
    const copied = [];
    for (const file of names) {
      const source = path.join(packageRoot, file), info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const output = `${metadata.name.replace(/[^a-z0-9._-]/gi, '_')}-${metadata.version}-${file}`;
      await copyFile(source, path.join(destination, output)); copied.push(output);
    }
    if (!copied.length) throw new Error(`Missing installed license text for runtime dependency ${identity}; release packaging stopped.`);
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? 'See included license text', files: copied });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) pending.push({ name: dependency, from: packageRoot });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return packages;
}

async function packagesUsedByBundle(inputs) {
  const roots = new Set();
  for (const rawInput of inputs) {
    const input = rawInput.replace(/^look-in-git-bundle:/, '');
    if (!input.split(/[\\/]/).includes('node_modules')) continue;
    let current = path.dirname(path.resolve(projectRoot, input));
    while (current !== path.dirname(current)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
        if (metadata.name && metadata.version) { roots.add(current); break; }
      } catch { /* Continue to the module's package root. */ }
      current = path.dirname(current);
    }
  }
  return [...roots];
}

async function releaseFiles(root, current = root) {
  const files = [];
  for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, item.name), relative = path.relative(root, absolute).split(path.sep).join('/');
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release directories cannot contain symbolic links: ${relative}`);
    if (info.isDirectory()) files.push(...await releaseFiles(root, absolute));
    else if (info.isFile() && relative !== 'manifest.sha256.json') files.push({ path: relative, bytes: info.size, sha256: sha256(await readFile(absolute)) });
    else if (!info.isFile()) throw new Error(`Unsupported release entry: ${relative}`);
  }
  return files;
}

export async function writeReleaseManifest(root, metadata) {
  const manifest = { format: 1, product: 'Look-in-Git', ...metadata, files: await releaseFiles(root) };
  await writeFile(path.join(root, 'manifest.sha256.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function verifyRelease(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.sha256.json'), 'utf8'));
  const actual = await releaseFiles(root);
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Release integrity verification failed: files are missing, changed, or unexpected.');
  return manifest;
}

export async function archiveRelease(source, destination) {
  if (process.platform !== 'win32') throw new Error('Client ZIP packaging currently requires Windows PowerShell.');
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('Archive paths must be absolute.');
  try { await lstat(destination); throw new Error('The release ZIP already exists and will not be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const helper = path.join(os.tmpdir(), `look-in-git-archive-${randomUUID()}.ps1`);
  await writeFile(helper, `param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)\n$ErrorActionPreference = 'Stop'\nif (Test-Path -LiteralPath $Destination) { throw 'The release ZIP already exists.' }\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination -CompressionLevel Optimal -ErrorAction Stop\n`, { flag: 'wx' });
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Source', source, '-Destination', destination], { shell: false, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
}

async function inspectRuntime(options) {
  if (!options.nodeRuntime) return undefined;
  if (path.basename(options.nodeRuntime).toLowerCase() !== 'node.exe' || !(await lstat(options.nodeRuntime)).isFile()) throw new Error('--node-runtime must point to a Windows node.exe file.');
  const handle = await open(options.nodeRuntime, 'r');
  try { const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0); if (header.toString() !== 'MZ') throw new Error('The supplied Node runtime is not a Windows executable.'); } finally { await handle.close(); }
  const runtime = JSON.parse((await execute(options.nodeRuntime, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { shell: false, windowsHide: true, timeout: 10000 })).stdout);
  const [major, minor] = runtime.version.split('.').map(Number);
  if (runtime.platform !== 'win32' || major < 22 || major === 22 && minor < 12) throw new Error(`The supplied runtime must be Windows Node.js ${minimumNode} or newer.`);
  const license = await readFile(options.nodeLicense, 'utf8');
  if (license.length < 10000 || !/Node\.js/.test(license) || !/Copyright/.test(license)) throw new Error('Supply the complete official Node.js LICENSE, including bundled third-party notices, from the exact runtime version.');
  return runtime;
}

export async function packageClient(options) {
  const policy = await readLicensePolicy(options.publicKey);
  const runtime = await inspectRuntime(options);
  const metadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i.test(metadata.version)) throw new Error('Package version must be a safe semantic version.');
  console.log('Checking types and building the client UI...');
  await execute(process.execPath, [path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], { cwd: projectRoot, shell: false, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await execute(process.execPath, [path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--configLoader', 'runner'], { cwd: projectRoot, shell: false, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const releases = path.join(projectRoot, 'artifacts', 'releases');
  await mkdir(releases, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '');
  const output = await mkdtemp(path.join(releases, `Look-in-Git-${metadata.version}-windows-${stamp}-`));
  const appRoot = path.join(output, 'app');
  await mkdir(appRoot);
  const result = await build({
    absWorkingDir: projectRoot, entryPoints: [path.join(projectRoot, 'server', 'index.ts')], outfile: path.join(appRoot, 'server.mjs'),
    tsconfigRaw: { compilerOptions: { target: 'ES2022', module: 'ESNext', esModuleInterop: true, strict: true } },
    plugins: [workspaceBundlePlugin()],
    bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true, sourcemap: false,
    external: ['vite'], legalComments: 'eof', metafile: true,
    define: { __LOOK_IN_GIT_LICENSE_POLICY__: JSON.stringify(policy) },
    banner: { js: "import { createRequire as __lookCreateRequire } from 'node:module'; const require = __lookCreateRequire(import.meta.url);" },
  });
  // Runtime dependencies must be bundled. The development-only Vite import is
  // deliberately external and cannot be reached by the packaged --prebuilt path.
  for (const item of Object.values(result.metafile.outputs)) for (const dependency of item.imports) if (dependency.external && !dependency.path.startsWith('node:') && dependency.path !== 'vite' && !builtinModules.includes(dependency.path)) throw new Error(`Unbundled client dependency: ${dependency.path}`);
  await cp(path.join(projectRoot, 'dist'), path.join(appRoot, 'dist'), { recursive: true, errorOnExist: true, force: false });
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'look-in-git-client', version: metadata.version, private: true, type: 'module' }, null, 2) + '\n');
  const apiText = await readFile(path.join(projectRoot, 'shared', 'protocol.ts'), 'utf8');
  const apiVersion = Number(apiText.match(/API_VERSION\s*=\s*(\d+)/)?.[1]);
  await writeFile(path.join(output, 'Start-Look-in-Git.ps1'), launcherPowerShell(apiVersion).replace(/\r?\n/g, '\r\n'));
  await writeFile(path.join(output, 'Start-Look-in-Git.cmd'), '@echo off\r\nsetlocal\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Look-in-Git.ps1"\r\nif errorlevel 1 pause\r\n');
  const packages = await collectThirdPartyNotices(path.join(output, 'licenses'), await packagesUsedByBundle(Object.keys(result.metafile.inputs)));
  if (runtime) {
    await mkdir(path.join(output, 'runtime'));
    await copyFile(options.nodeRuntime, path.join(output, 'runtime', 'node.exe'));
    await copyFile(options.nodeLicense, path.join(output, 'runtime', 'LICENSE.txt'));
  }
  await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), `Look-in-Git ${metadata.version}\n\nIncluded third-party components and their original license texts:\n\n${packages.map(item => `${item.name} ${item.version} (${typeof item.license === 'string' ? item.license : JSON.stringify(item.license)})\n${item.files.map(file => '  licenses/' + file).join('\n')}`).join('\n\n')}\n${runtime ? `\nNode.js ${runtime.version} (${runtime.arch}) is included. Its complete supplied license is runtime/LICENSE.txt. The release issuer is responsible for supplying the official license from that exact Node distribution.\n` : '\nNode.js and Git are prerequisites installed separately; their executables are not included.\n'}`);
  await writeFile(path.join(output, 'NOTICE.txt'), `Copyright ${new Date().getFullYear()} Look-in-Git. All rights reserved.\n\nThird-party components remain subject to their included license texts. This notice is not an EULA.\n`);
  await writeFile(path.join(output, 'QuickStart.txt'), `LOOK-IN-GIT ${metadata.version}\n\n1. Extract the entire ZIP to a local folder. Do not run directly from inside the ZIP.\n2. Install Git for Windows with command-line access: https://git-scm.com/download/win\n${runtime ? `3. Node.js ${runtime.version} (${runtime.arch}) is included in this package.\n` : '3. Install Node.js LTS, version 22.12 or newer: https://nodejs.org\n'}4. Double-click Start-Look-in-Git.cmd. Your browser opens when the app is ready.\n5. Keep the terminal window open; press Ctrl+C there to stop the app.\n\nNo npm install, compilation, account, or cloud service is required on the client. The server binds only to 127.0.0.1. Repository actions use your normal Git credential helpers and SSH setup.\n\nThe app includes a 30-day local trial. Activate a signed license from the software provider in the app. Trial and activation data stay on this computer. No issuer private key is included.\n\nThe default repository discovery folder is your home folder's code directory. You can open any other local repository from the top ribbon.\n\nIf port 4317 is busy, stop the earlier instance or launch from PowerShell:\n  $env:LOOK_IN_GIT_PORT = '4318'\n  .\\Start-Look-in-Git.cmd\n\nManaged computers may restrict unsigned PowerShell scripts. Follow your organization's software policy; no administrator privileges or system policy changes are required by this app.\n\nFor upgrades, stop the old copy and extract the new release to a separate folder. Your repositories and local licensing data are not stored inside this application folder.\n\nmanifest.sha256.json records every shipped file's SHA-256 checksum. The adjacent ZIP .sha256 file identifies this archive. These checksums detect accidental changes; this release is not code signed.\n`);
  await writeReleaseManifest(output, { version: metadata.version, createdAt: new Date().toISOString(), minimumNode, bundledNode: runtime ?? null, publicKeyFingerprint: sha256(policy.publicKey) });
  await verifyRelease(output);
  const archive = output + '.zip';
  await archiveRelease(await realpath(output), archive);
  const checksum = sha256(await readFile(archive));
  await writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`, { flag: 'wx' });
  console.log(`\nClient ZIP: ${archive}\nSHA-256: ${checksum}\n${runtime ? `Includes Node.js ${runtime.version}; Git for Windows is required.` : `Requires Git for Windows and Node.js ${minimumNode} or newer. No npm install is required.`}`);
  return { directory: output, archive, checksum };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: npm.cmd run package:client -- [--public-key public.pem] [--node-runtime C:\\path\\node.exe --node-license C:\\path\\LICENSE]\nNode bundling requires the complete official LICENSE from that exact Node distribution.');
    else await packageClient(options);
  } catch (error) {
    console.error('Client packaging failed.');
    console.error(error.stdout || error.stderr || error.message);
    process.exitCode = 1;
  }
}
