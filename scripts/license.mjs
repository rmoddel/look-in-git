import { generateKeyPairSync, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

function fail(message) { throw new Error(message); }
function flags(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!allowed.includes(name) || result[name] !== undefined || !value || value.startsWith('--')) fail(`Invalid or missing argument: ${name ?? ''}`);
    result[name] = value;
  }
  return result;
}
function cleanText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
async function exclusiveFile(file, content, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx', mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init') {
    const options = flags(args, ['--out']);
    if (!options['--out']) fail('Usage: node scripts/license.mjs init --out artifacts/issuer');
    const folder = path.resolve(options['--out']), privatePath = path.join(folder, 'private.pem'), publicPath = path.join(folder, 'public.pem');
    for (const file of [privatePath, publicPath]) {
      try { await stat(file); fail(`Refusing to overwrite an existing key: ${file}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await exclusiveFile(privatePath, privateKey);
    await exclusiveFile(publicPath, publicKey, 0o644);
    process.stdout.write(`Created issuer keys in ${folder}\nKeep private.pem on the issuer machine. Distribute only public.pem with releases.\n`);
  } else if (command === 'issue') {
    const options = flags(args, ['--key', '--customer', '--days', '--device', '--out']);
    if (!options['--key'] || !options['--out'] || !cleanText(options['--customer'], 200)) fail('Usage: node scripts/license.mjs issue --key artifacts/issuer/private.pem --customer "Client" [--days 365] [--device ID] --out client.lic');
    if (options['--days'] !== undefined && (!/^\d{1,5}$/.test(options['--days']) || Number(options['--days']) < 1 || Number(options['--days']) > 36500)) fail('--days must be an integer from 1 to 36500; omit it for a perpetual license.');
    if (options['--device'] !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(options['--device'])) fail('--device must match the device ID shown by Look-in-Git.');
    const keyPath = path.resolve(options['--key']);
    const info = await stat(keyPath);
    if (!info.isFile() || info.size > 16_384) fail('The private key file is invalid.');
    const key = createPrivateKey(await readFile(keyPath, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') fail('An Ed25519 private key is required.');
    const now = Date.now();
    const payload = { version: 1, productId: 'look-in-git', licenseId: randomUUID(), customer: options['--customer'].trim(), issuedAt: new Date(now).toISOString(), ...(options['--days'] ? { expiresAt: new Date(now + Number(options['--days']) * 86_400_000).toISOString() } : {}), ...(options['--device'] ? { deviceId: options['--device'] } : {}) };
    const bytes = Buffer.from(JSON.stringify(payload));
    const token = `${bytes.toString('base64url')}.${sign(null, bytes, key).toString('base64url')}\n`;
    const target = path.resolve(options['--out']);
    await exclusiveFile(target, token);
    process.stdout.write(`License written to ${target}\nCustomer: ${payload.customer}\nExpires: ${payload.expiresAt ?? 'Never (perpetual)'}\n`);
  } else fail('Commands: init --out <issuer-folder> | issue --key <private.pem> --customer <name> [--days N] [--device ID] --out <license.lic>');
}
main().catch(error => { process.stderr.write(`License tool: ${error.code === 'EEXIST' ? 'The output file already exists; it was not overwritten.' : error.message}\n`); process.exitCode = 1; });
