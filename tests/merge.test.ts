import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';

const { app } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317';
let token: string;
const cleanup: string[] = [];
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const root of cleanup) await removeFixture(root); });
const post = (url: string, body: unknown) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object);
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
async function conflict() {
  const fixture = await createFixture(true); cleanup.push(fixture.base);
  const file = path.join(fixture.root, 'story.txt');
  await writeFile(file, 'Shared opening\nBase ending\n');
  await fixtureGit(fixture.root, ['add', '.']); await fixtureGit(fixture.root, ['commit', '-m', 'Base']);
  await fixtureGit(fixture.root, ['switch', '-c', 'feature']);
  await writeFile(file, 'Shared opening\nFeature ending\n');
  await fixtureGit(fixture.root, ['commit', '-am', 'Feature']);
  await fixtureGit(fixture.root, ['switch', 'main']);
  await writeFile(file, 'Shared opening\nMain ending\n');
  await fixtureGit(fixture.root, ['commit', '-am', 'Main']);
  const opened = await post('/api/repositories', { path: fixture.root });
  const url = `/api/repositories/${opened.body.id}`;
  const merged = await post(url + '/actions', { action: 'merge', target: 'feature' });
  expect(merged.status).toBe(422);
  const result = await get(url + '/merge?path=story.txt');
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { ...fixture, file, url, data: result.body };
}

describe('embedded merge editor using real Git conflicts', () => {
  it('reads all three stages, saves a draft, stages a resolution and completes a merge', async () => {
    const repo = await conflict();
    expect(repo.data).toMatchObject({ base: 'Shared opening\nBase ending\n', ours: 'Shared opening\nMain ending\n', theirs: 'Shared opening\nFeature ending\n', binary: false, missing: false });
    const payload = { path: 'story.txt', content: 'Shared opening\nBoth endings reconciled\n', fingerprint: repo.data.fingerprint, indexFingerprint: repo.data.indexFingerprint, stage: false };
    const saved = await post(repo.url + '/merge', payload);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await readFile(repo.file, 'utf8')).toBe(payload.content);
    expect(await fixtureGit(repo.root, ['ls-files', '-u'])).not.toBe('');
    const staged = await post(repo.url + '/merge', { ...payload, stage: true, fingerprint: saved.body.fingerprint });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(await fixtureGit(repo.root, ['ls-files', '-u'])).toBe('');
    expect((await post(repo.url + '/actions', { action: 'commit', message: 'Resolve both endings\n\nKeep the shared opening.' })).status).toBe(200);
    expect((await fixtureGit(repo.root, ['log', '-1', '--format=%P'])).split(' ')).toHaveLength(2);
  });
  it('rejects conflict markers, stale worktree/index fingerprints, traversal and missing tokens', async () => {
    const repo = await conflict();
    const payload = { path: 'story.txt', content: repo.data.result, fingerprint: repo.data.fingerprint, indexFingerprint: repo.data.indexFingerprint, stage: true };
    expect((await post(repo.url + '/merge', payload)).body.error.code).toBe('CONFLICT_MARKERS');
    const external = repo.data.result + '\nExternal edit\n'; await writeFile(repo.file, external);
    expect((await post(repo.url + '/merge', { ...payload, content: 'Resolved\n' })).body.error.code).toBe('MERGE_CHANGED');
    expect(await readFile(repo.file, 'utf8')).toBe(external);
    const refreshed = (await get(repo.url + '/merge?path=story.txt')).body;
    expect((await post(repo.url + '/merge', { ...payload, content: 'Resolved\n', fingerprint: refreshed.fingerprint, indexFingerprint: '0'.repeat(64) })).body.error.code).toBe('MERGE_CHANGED');
    expect((await get(repo.url + '/merge?path=../outside')).status).toBe(400);
    expect((await request(app).post(repo.url + '/merge').set('Host', host).send(payload)).status).toBe(403);
    expect((await post(repo.url + '/actions', { action: 'merge-abort' })).status).toBe(200);
    expect((await get(repo.url + '/merge?path=story.txt')).status).toBe(409);
  });
  it('continues a conflicted rebase after staging an embedded-editor resolution', async () => {
    const repo = await conflict();
    expect((await post(repo.url + '/actions', { action: 'merge-abort' })).status).toBe(200);
    expect((await post(repo.url + '/actions', { action: 'rebase', target: 'feature' })).status).toBe(422);
    expect((await get(repo.url + '/action-options')).body.rebaseInProgress).toBe(true);
    const current = (await get(repo.url + '/merge?path=story.txt')).body;
    expect((await post(repo.url + '/merge', { path: 'story.txt', content: 'Shared opening\nReconciled during rebase\n', fingerprint: current.fingerprint, indexFingerprint: current.indexFingerprint, stage: true })).status).toBe(200);
    const continued = await post(repo.url + '/actions', { action: 'rebase-continue' });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect((await get(repo.url + '/action-options')).body.rebaseInProgress).toBe(false);
    expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
    expect(await readFile(repo.file, 'utf8')).toBe('Shared opening\nReconciled during rebase\n');
  });
});
