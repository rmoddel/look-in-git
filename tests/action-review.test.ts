import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';

const { app } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317', cleanup: string[] = [];
let token: string;
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const root of cleanup) await removeFixture(root); });
const post = (url: string, body: object) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body);
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
async function fresh(empty = false) {
  const repo = await createFixture(empty); cleanup.push(repo.base);
  const opened = await post('/api/repositories', { path: repo.root });
  expect(opened.status).toBe(200);
  return { ...repo, url: `/api/repositories/${opened.body.id}` };
}
async function divergent() {
  const repo = await fresh(true);
  await writeFile(path.join(repo.root, 'base.txt'), 'Base\n');
  await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', 'Base']);
  await fixtureGit(repo.root, ['switch', '-c', 'feature']);
  for (const name of ['one', 'two']) {
    await writeFile(path.join(repo.root, `${name}.txt`), `${name}\n`);
    await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', `Add ${name}`]);
  }
  const source = await fixtureGit(repo.root, ['rev-parse', 'HEAD']);
  await fixtureGit(repo.root, ['switch', 'main']);
  await writeFile(path.join(repo.root, 'local.txt'), 'Local\n');
  await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', 'Local work']);
  return { ...repo, source, head: await fixtureGit(repo.root, ['rev-parse', 'HEAD']) };
}

it('previews exact push/pull directions, cached counts, and excluded files without changing the repo', async () => {
  const repo = await fresh();
  const remote = path.join(repo.base, 'remote.git'); await mkdir(remote); await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
  await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
  await fixtureGit(repo.root, ['push', 'origin', `${repo.initial}:refs/heads/main`]);
  const before = await snapshot(repo.root);
  const push = await get(repo.url + '/action-review?action=push&remote=origin');
  expect(push.status).toBe(200);
  expect(push.body).toMatchObject({ source: 'main', destination: 'origin/main', outgoing: 1, incoming: 0, countsAreCached: true, blocked: null, submitLabel: 'Push to origin/main' });
  expect(push.body.warnings.join(' ')).toContain('excluded from this push');
  const pull = await get(repo.url + '/action-review?action=pull&remote=origin');
  expect(pull.body).toMatchObject({ source: 'origin/main', destination: 'main', submitLabel: 'Pull into main' });
  expect(pull.body.details.join(' ')).toContain('fast-forward');
  expect(await snapshot(repo.root)).toBe(before);
});

it('redacts remote URL credentials and defaults to a differently named upstream without contacting a host', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['remote', 'add', 'origin', 'https://private-user:private-token@example.invalid/project.git?token=private-query']);
  await fixtureGit(repo.root, ['update-ref', 'refs/remotes/origin/other', repo.initial]);
  await fixtureGit(repo.root, ['branch', '--set-upstream-to=origin/other', 'main']);
  const review = await get(repo.url + '/action-review?action=push&remote=origin');
  expect(review.status).toBe(200);
  expect(review.body.remoteUrls).toEqual(['https://example.invalid/project.git']);
  expect(JSON.stringify(review.body)).not.toContain('private-');
  expect(review.body).toMatchObject({ destination: 'origin/other', remoteBranch: 'other', incoming: 0, outgoing: 1 });
  expect(review.body.details.join(' ')).toContain('preserves');
  expect((await get(repo.url + '/action-review?action=push&remote=--all')).status).toBe(400);
  expect((await get(repo.url + '/action-review?action=exec')).status).toBe(400);
  expect((await get(repo.url + '/action-review?action=merge&target=--help')).status).toBe(400);
});

it('squashes source changes for a separate single-parent commit without rewriting either branch', async () => {
  const repo = await divergent();
  const review = (await get(repo.url + '/action-review?action=squash&target=feature')).body;
  expect(review).toMatchObject({ source: 'feature', destination: 'main', incoming: 2, outgoing: 1, countsAreCached: false, blocked: null });
  expect(review.details.join(' ')).toContain('Stops before committing');
  const result = await post(repo.url + '/actions', { action: 'squash', target: 'feature', reviewFingerprint: review.fingerprint });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.command).toContain('--squash');
  expect(result.body.summary).toContain('then commit');
  expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(repo.head);
  expect(await fixtureGit(repo.root, ['rev-parse', 'feature'])).toBe(repo.source);
  expect((await get(repo.url + '/action-options')).body.mergeInProgress).toBe(false);
  expect(await fixtureGit(repo.root, ['diff', '--cached', '--name-only'])).toBe('one.txt\ntwo.txt');
  expect((await post(repo.url + '/actions', { action: 'commit', message: 'Combine feature changes' })).status).toBe(200);
  expect(await fixtureGit(repo.root, ['log', '-1', '--format=%P'])).toBe(repo.head);
  expect(await readFile(path.join(repo.root, 'two.txt'), 'utf8')).toBe('two\n');
});

it('blocks squash when unrelated local changes would enter its result', async () => {
  const repo = await fresh();
  const review = (await get(repo.url + '/action-review?action=squash&target=feature/focus-mode')).body;
  expect(review.blocked).toContain('Commit or stash');
  const before = await snapshot(repo.root);
  const result = await post(repo.url + '/actions', { action: 'squash', target: 'feature/focus-mode', reviewFingerprint: review.fingerprint });
  expect(result.status).toBe(409);
  expect(await snapshot(repo.root)).toBe(before);
});

it('rejects a stale review after checkout or source movement, before running the action', async () => {
  const repo = await divergent();
  const review = (await get(repo.url + '/action-review?action=merge&target=feature')).body;
  await fixtureGit(repo.root, ['switch', 'feature']);
  let before = await snapshot(repo.root);
  let result = await post(repo.url + '/actions', { action: 'merge', target: 'feature', reviewFingerprint: review.fingerprint });
  expect(result.body.error.code).toBe('ACTION_CHANGED');
  expect(await snapshot(repo.root)).toBe(before);
  await fixtureGit(repo.root, ['switch', 'main']);
  await fixtureGit(repo.root, ['branch', '-f', 'feature', 'main']);
  before = await snapshot(repo.root);
  result = await post(repo.url + '/actions', { action: 'merge', target: 'feature', reviewFingerprint: review.fingerprint });
  expect(result.body.error.code).toBe('ACTION_CHANGED');
  expect(await snapshot(repo.root)).toBe(before);
});

it('normal merge honors the preview even when merge.ff is configured as only', async () => {
  const repo = await divergent();
  await fixtureGit(repo.root, ['config', 'merge.ff', 'only']);
  const review = (await get(repo.url + '/action-review?action=merge&target=feature')).body;
  expect(review.details.join(' ')).toContain('creates a merge commit automatically');
  const result = await post(repo.url + '/actions', { action: 'merge', target: 'feature', reviewFingerprint: review.fingerprint });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await fixtureGit(repo.root, ['log', '-1', '--format=%P'])).split(' ')).toEqual([repo.head, repo.source]);
});

it('blocks detached and unborn branch reviews with useful guidance', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['checkout', '--detach']);
  expect((await get(repo.url + '/action-review?action=merge&target=main')).body.blocked).toContain('HEAD is detached');
  const empty = await fresh(true);
  await fixtureGit(empty.root, ['remote', 'add', 'origin', 'https://example.invalid/project.git']);
  expect((await get(empty.url + '/action-review?action=push&remote=origin')).body.blocked).toContain('first commit');
});
