import { afterAll, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, realpath, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createLicenseManager, type LicensePolicy } from '../server/licensing';

const execute = promisify(execFile);
const pair = generateKeyPairSync('ed25519');
const policy: LicensePolicy = { productId: 'look-in-git', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), trialDays: 30 };
const BASE = Date.parse('2027-01-01T12:00:00.000Z'), DAY = 86_400_000;
const deviceId = 'fixture-device-a';
const cleanup: string[] = [];
async function folder() { const root = await mkdtemp(path.join(os.tmpdir(), 'look-in-git-license-')); cleanup.push(root); return root; }
afterAll(async () => {
  const temporary = await realpath(os.tmpdir());
  for (const root of cleanup) {
    const actual = await realpath(root), relative = path.relative(temporary, actual);
    if (path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('look-in-git-license-')) throw new Error('Refusing to remove a non-license-test folder.');
    await rm(actual, { recursive: true, force: true });
  }
});
function license(overrides: Record<string, unknown> = {}, signingKey = pair.privateKey) {
  const value = { version: 1, productId: 'look-in-git', licenseId: randomUUID(), customer: 'Fixture Customer', issuedAt: new Date(BASE - DAY).toISOString(), ...overrides };
  const bytes = Buffer.from(JSON.stringify(value));
  return `${bytes.toString('base64url')}.${sign(null, bytes, signingKey).toString('base64url')}`;
}
async function fresh(initial = BASE) {
  const stateDirectory = await folder();
  let current = initial;
  const options = { stateDirectory, now: () => current, deviceId };
  const manager = await createLicenseManager(policy, options);
  return { stateDirectory, options, manager, advance: (time: number) => { current = time; } };
}

it('starts a thirty-day offline trial and preserves its original expiry after restart', async () => {
  const test = await fresh();
  const first = await test.manager.status();
  expect(first).toMatchObject({ mode: 'trial', allowed: true, daysRemaining: 30, deviceId, expiresAt: new Date(BASE + 30 * DAY).toISOString() });
  test.advance(BASE + 7 * DAY);
  expect(await test.manager.status()).toMatchObject({ mode: 'trial', daysRemaining: 23 });
  const resumed = await createLicenseManager(policy, test.options);
  expect(await resumed.status()).toMatchObject({ mode: 'trial', daysRemaining: 23, expiresAt: first.expiresAt });
  const persisted = JSON.parse(await readFile(path.join(test.stateDirectory, 'license-state.json'), 'utf8'));
  expect(persisted).toMatchObject({ version: 1, productId: 'look-in-git', deviceId, trialStartedAt: new Date(BASE).toISOString(), lastSeenAt: new Date(BASE + 7 * DAY).toISOString() });
  expect(persisted.installationId).toHaveLength(36);
  test.advance(BASE + 30 * DAY);
  expect(await resumed.status()).toMatchObject({ mode: 'expired', allowed: false, daysRemaining: 0 });
  expect(await readdir(test.stateDirectory)).toEqual(['license-state.json']);
});

it('activates a perpetual signed license after trial expiry and persists it on restart', async () => {
  const test = await fresh(); test.advance(BASE + 31 * DAY);
  expect((await test.manager.status()).allowed).toBe(false);
  const result = await test.manager.activate(`  ${license()}\n`);
  expect(result).toMatchObject({ mode: 'licensed', allowed: true, customer: 'Fixture Customer', daysRemaining: null, expiresAt: null, deviceId });
  const resumed = await createLicenseManager(policy, test.options);
  expect(await resumed.status()).toMatchObject({ mode: 'licensed', allowed: true, customer: 'Fixture Customer' });
});

it('enforces paid-license expiry and permits a renewed license without restarting the trial', async () => {
  const test = await fresh();
  const expiresAt = new Date(BASE + 3 * DAY).toISOString();
  expect(await test.manager.activate(license({ expiresAt }))).toMatchObject({ mode: 'licensed', expiresAt, daysRemaining: 3 });
  test.advance(BASE + 3 * DAY);
  expect(await test.manager.status()).toMatchObject({ mode: 'expired', allowed: false, expiresAt, customer: 'Fixture Customer' });
  await expect(test.manager.activate(license({ expiresAt }))).rejects.toMatchObject({ code: 'LICENSE_EXPIRED' });
  expect((await test.manager.activate(license())).mode).toBe('licensed');
  const state = JSON.parse(await readFile(path.join(test.stateDirectory, 'license-state.json'), 'utf8'));
  expect(state.trialStartedAt).toBe(new Date(BASE).toISOString());
});

it('rejects invalid signatures, wrong products, wrong devices and malformed fields without changing the trial', async () => {
  const test = await fresh();
  const other = generateKeyPairSync('ed25519');
  await expect(test.manager.activate(license({}, other.privateKey))).rejects.toMatchObject({ code: 'LICENSE_INVALID' });
  await expect(test.manager.activate(license({ productId: 'other-product' }))).rejects.toMatchObject({ code: 'LICENSE_WRONG_PRODUCT' });
  await expect(test.manager.activate(license({ deviceId: 'fixture-device-b' }))).rejects.toMatchObject({ code: 'LICENSE_WRONG_DEVICE' });
  for (const token of [null, {}, 'bad.license', license({ extra: true }), license({ version: 2 }), license({ expiresAt: null }), license({ customer: 'Bad\nName' }), license({ issuedAt: 'not-a-date' }), license({ expiresAt: new Date(BASE - 2 * DAY).toISOString() })]) await expect(test.manager.activate(token)).rejects.toMatchObject({ code: 'LICENSE_INVALID' });
  expect(await test.manager.status()).toMatchObject({ mode: 'trial', allowed: true, daysRemaining: 30 });
  expect((await test.manager.activate(license({ deviceId }))).mode).toBe('licensed');
});

it('rejects licenses issued too far in the future and does not treat them as trial renewals', async () => {
  const test = await fresh();
  await expect(test.manager.activate(license({ issuedAt: new Date(BASE + DAY).toISOString() }))).rejects.toMatchObject({ code: 'LICENSE_NOT_YET_VALID' });
  expect(await test.manager.status()).toMatchObject({ mode: 'trial', daysRemaining: 30 });
});

it('blocks clock rollback after restart, tolerates small corrections, and recovers when the clock is corrected', async () => {
  const test = await fresh();
  test.advance(BASE + DAY); await test.manager.status();
  test.advance(BASE + DAY - 4 * 60_000);
  expect((await test.manager.status()).mode).toBe('trial');
  test.advance(BASE + DAY - 6 * 60_000);
  const resumed = await createLicenseManager(policy, test.options);
  expect(await resumed.status()).toMatchObject({ mode: 'clock-error', allowed: false });
  await expect(resumed.activate(license())).rejects.toMatchObject({ code: 'LICENSE_CLOCK_ERROR' });
  test.advance(BASE + DAY);
  expect((await resumed.status()).allowed).toBe(true);
});

it('fails closed for corrupted existing state and never overwrites it to start a new trial', async () => {
  const stateDirectory = await folder(), statePath = path.join(stateDirectory, 'license-state.json');
  await writeFile(statePath, '{ damaged');
  const manager = await createLicenseManager(policy, { stateDirectory, deviceId, now: () => BASE });
  expect(await manager.status()).toMatchObject({ mode: 'invalid', allowed: false });
  await expect(manager.activate(license())).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID' });
  expect(await readFile(statePath, 'utf8')).toBe('{ damaged');
});

it('fails closed for a tampered stored license and refuses to use another device state', async () => {
  const test = await fresh(); await test.manager.activate(license());
  const statePath = path.join(test.stateDirectory, 'license-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.license = license({ customer: 'Other customer' }, generateKeyPairSync('ed25519').privateKey);
  await writeFile(statePath, JSON.stringify(state));
  expect(await test.manager.status()).toMatchObject({ mode: 'invalid', allowed: false });
  const moved = await createLicenseManager(policy, { ...test.options, deviceId: 'fixture-device-b' });
  expect(await moved.status()).toMatchObject({ mode: 'invalid', allowed: false });
});

it('rejects invalid release policies before creating trial state', async () => {
  const stateDirectory = await folder();
  for (const value of [{ ...policy, trialDays: 0 }, { ...policy, publicKey: 'not-a-key' }, { ...policy, productId: 'other' }]) await expect(createLicenseManager(value, { stateDirectory, deviceId, now: () => BASE })).rejects.toMatchObject({ code: 'LICENSE_POLICY_INVALID' });
  expect(await readdir(stateDirectory)).toEqual([]);
});

it('issuer CLI creates exclusive keys and produces perpetual and device-bound licenses accepted by the app', async () => {
  const root = await folder(), issuer = path.join(root, 'issuer'), keyPath = path.join(issuer, 'private.pem');
  const script = path.resolve('scripts/license.mjs');
  const initialized = await execute(process.execPath, [script, 'init', '--out', issuer], { windowsHide: true, shell: false });
  expect(initialized.stdout).not.toContain('BEGIN PRIVATE KEY');
  const privateBefore = await readFile(keyPath, 'utf8');
  await expect(execute(process.execPath, [script, 'init', '--out', issuer], { windowsHide: true, shell: false })).rejects.toThrow();
  expect(await readFile(keyPath, 'utf8')).toBe(privateBefore);
  const localPolicy = { ...policy, publicKey: await readFile(path.join(issuer, 'public.pem'), 'utf8') };
  const manager = await createLicenseManager(localPolicy, { stateDirectory: path.join(root, 'state'), deviceId });
  const perpetual = path.join(root, 'perpetual.lic');
  await execute(process.execPath, [script, 'issue', '--key', keyPath, '--customer', 'Offline Customer', '--out', perpetual], { windowsHide: true, shell: false });
  expect(await manager.activate(await readFile(perpetual, 'utf8'))).toMatchObject({ mode: 'licensed', customer: 'Offline Customer', expiresAt: null });
  const limited = path.join(root, 'limited.lic');
  await execute(process.execPath, [script, 'issue', '--key', keyPath, '--customer', 'Device Customer', '--days', '365', '--device', deviceId, '--out', limited], { windowsHide: true, shell: false });
  expect(await manager.activate(await readFile(limited, 'utf8'))).toMatchObject({ mode: 'licensed', customer: 'Device Customer', daysRemaining: 365 });
  await expect(execute(process.execPath, [script, 'issue', '--key', keyPath, '--customer', 'Other', '--out', limited], { windowsHide: true, shell: false })).rejects.toThrow();
  await expect(execute(process.execPath, [script, 'issue', '--key', keyPath, '--customer', 'Other', '--days', '-1', '--out', path.join(root, 'invalid.lic')], { windowsHide: true, shell: false })).rejects.toThrow();
});
