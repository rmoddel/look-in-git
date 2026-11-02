import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp, errorHandler } from '../server/app';
import { createLicenseManager, type LicensePolicy } from '../server/licensing';
import { createFixture, removeFixture, snapshot } from '../scripts/fixture';

const host = '127.0.0.1:4317', origin = `http://${host}`;
const BASE = Date.parse('2027-01-01T12:00:00.000Z'), DAY = 86_400_000;
const keys = generateKeyPairSync('ed25519');
const policy: LicensePolicy = { productId: 'look-in-git', trialDays: 30, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeAll(async () => { fixture = await createFixture(); });
afterAll(async () => { if (fixture) await removeFixture(fixture.base); });

function paidLicense() {
  const payload = Buffer.from(JSON.stringify({ version: 1, productId: 'look-in-git', licenseId: randomUUID(), customer: 'API Fixture Customer', issuedAt: new Date(BASE).toISOString() }));
  return `${payload.toString('base64url')}.${sign(null, payload, keys.privateKey).toString('base64url')}`;
}
async function session() {
  let current = BASE;
  const stateDirectory = path.join(fixture.base, `license-${randomUUID()}`);
  await mkdir(stateDirectory);
  const manager = await createLicenseManager(policy, { stateDirectory, deviceId: 'fixture-api-device', now: () => current });
  const { app } = createApp({ license: manager }); app.use(errorHandler);
  const initial = await request(app).get('/api/session').set('Host', host);
  expect(initial.status).toBe(200);
  expect(initial.body.license).toMatchObject({ mode: 'trial', allowed: true, daysRemaining: 30 });
  const token = initial.body.token as string;
  const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
  const post = (url: string, body: object = {}) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body);
  const opened = await post('/api/repositories', { path: fixture.root });
  expect(opened.status).toBe(200);
  return { app, manager, token, get, post, id: opened.body.id as string, expire: () => { current = BASE + 30 * DAY; } };
}

it('keeps session and license status available after expiry without exposing open repositories', async () => {
  const test = await session();
  expect((await test.get(`/api/repositories/${test.id}/working`)).status).toBe(200);
  test.expire();
  const reconnect = await request(test.app).get('/api/session').set('Host', host);
  expect(reconnect.status).toBe(200);
  expect(reconnect.body.token).toBe(test.token);
  expect(reconnect.body.license).toMatchObject({ mode: 'expired', allowed: false, daysRemaining: 0 });
  expect(reconnect.body.repositories).toEqual([]);
  const status = await test.get('/api/license');
  expect(status.status).toBe(200);
  expect(status.body.mode).toBe('expired');
  expect((await request(test.app).get('/api/license').set('Host', host)).status).toBe(403);
  expect((await request(test.app).get('/api/session').set('Host', host).set('Origin', 'https://other.example')).status).toBe(403);
});

it('blocks every Git read API when a previously active session expires', async () => {
  const test = await session(), before = await snapshot(fixture.root);
  test.expire();
  const paths = ['working', 'history', 'branches', 'action-options', 'operations', 'tools', 'reflog', 'credentials', 'action-review?action=merge&target=HEAD', 'commit?ref=HEAD', `stash?hash=${fixture.latest}`, 'discard-review?path=both.txt', 'merge?path=both.txt', 'comparison?scope=compare&from=HEAD&to=HEAD', 'diff?scope=unstaged&path=both.txt'];
  for (const resource of paths) {
    const result = await test.get(`/api/repositories/${test.id}/${resource}`);
    expect(result.status, resource).toBe(402);
    expect(result.body.error.code, resource).toBe('LICENSE_REQUIRED');
  }
  expect((await test.get('/api/repositories/unknown/working')).status).toBe(402);
  expect(await snapshot(fixture.root)).toBe(before);
});

it('blocks every Git write and discovery API before handlers can mutate the repository', async () => {
  const test = await session(), before = await snapshot(fixture.root);
  test.expire();
  const writes: [string, object][] = [
    ['/api/repositories', { path: fixture.root }],
    ['/api/repositories/create', { action: 'init', path: path.join(fixture.base, 'must-not-create') }],
    ['/api/discover', { path: fixture.base }],
    [`/api/repositories/${test.id}/actions`, { action: 'stage-all' }],
    [`/api/repositories/${test.id}/lines`, { action: 'stage', path: 'both.txt', lines: [1] }],
    [`/api/repositories/${test.id}/tools`, { action: 'tag-create', name: 'must-not-create', target: 'HEAD' }],
    [`/api/repositories/${test.id}/credentials`, { remote: 'origin', username: 'fixture', secret: 'never-forward-this' }],
    [`/api/repositories/${test.id}/merge`, { path: 'both.txt', content: 'must not write', stage: true }],
  ];
  for (const [url, body] of writes) {
    const result = await test.post(url, body);
    expect(result.status, url).toBe(402);
    expect(result.body.error.code, url).toBe('LICENSE_REQUIRED');
  }
  expect(await snapshot(fixture.root)).toBe(before);
});

it('does not accept client-supplied license state, query switches, alternate casing, or activation-shaped paths as a bypass', async () => {
  const test = await session(); test.expire();
  const working = `/api/repositories/${test.id}/working`;
  for (const url of [working + '?license=development&allowed=true&trialDays=9999', working + '/', working.replace('/working', '/WORKING'), working.replace('/api/', '/API/'), '/api/license/activate/repositories/' + test.id + '/working']) {
    const result = await test.get(url).set('X-Look-in-Git-License', 'development');
    expect(result.status, url).toBe(402);
    expect(result.body.error.code).toBe('LICENSE_REQUIRED');
  }
  const bodyBypass = await test.post(`/api/repositories/${test.id}/actions`, { action: 'stage-all', license: { allowed: true, mode: 'licensed' }, trialDays: 9999 });
  expect(bodyBypass.status).toBe(402);
  expect(bodyBypass.body.error.code).toBe('LICENSE_REQUIRED');
  const invalidActivation = await test.post('/api/license/activate', { key: 'pretend-key', allowed: true });
  expect(invalidActivation.status).toBe(400);
  expect((await test.get(working)).status).toBe(402);
});

it('accepts a valid signed license after expiry and restores access with the existing session token and repository ID', async () => {
  const test = await session(), before = await snapshot(fixture.root);
  test.expire();
  expect((await test.get(`/api/repositories/${test.id}/working`)).status).toBe(402);
  const activated = await test.post('/api/license/activate', { key: paidLicense() });
  expect(activated.status).toBe(200);
  expect(activated.body).toMatchObject({ mode: 'licensed', allowed: true, customer: 'API Fixture Customer' });
  const working = await test.get(`/api/repositories/${test.id}/working`);
  expect(working.status).toBe(200);
  expect(working.body.branch).toBe('main');
  const reconnect = await request(test.app).get('/api/session').set('Host', host);
  expect(reconnect.body.token).toBe(test.token);
  expect(reconnect.body.repositories.some((repo: { id: string }) => repo.id === test.id)).toBe(true);
  expect(await snapshot(fixture.root)).toBe(before);
});

it('keeps activation behind the same token, host, origin and fetch-site boundary even when expired', async () => {
  const test = await session(); test.expire();
  const key = paidLicense();
  const requests = [
    request(test.app).post('/api/license/activate').set('Host', host),
    request(test.app).post('/api/license/activate').set('Host', host).set('X-Look-in-Git-Token', '0'.repeat(64)),
    test.post('/api/license/activate', { key }).set('Origin', 'https://untrusted.example'),
    test.post('/api/license/activate', { key }).set('Origin', 'null'),
    test.post('/api/license/activate', { key }).set('Host', 'attacker.example'),
    test.post('/api/license/activate', { key }).set('Sec-Fetch-Site', 'cross-site'),
  ];
  for (const candidate of requests) expect((await candidate.send({ key })).status).toBe(403);
  expect((await test.get('/api/license')).body.allowed).toBe(false);
  expect((await test.post('/api/license/activate', { key }).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
});
