import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';
import type { ActionRequest, ChangedFile } from '../shared/types';
import { discardReview } from '../server/discard-review';

const { app, repositories } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317';
let token: string;
const cleanup: string[] = [];
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const root of cleanup) await removeFixture(root); });
function post(url: string, value: unknown) { return request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(value as object); }
function get(url: string) { return request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token); }
async function fresh(empty = false) {
  const fixture = await createFixture(empty); cleanup.push(fixture.base);
  const opened = await post('/api/repositories', { path: fixture.root });
  expect(opened.status).toBe(200);
  const id: string = opened.body.id;
  return { ...fixture, id, action: (body: ActionRequest) => post(`/api/repositories/${id}/actions`, body) };
}
async function successful(result: Promise<request.Response>) {
  const response = await result;
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.command[0]).toBe('git');
  return response;
}

describe('explicit Git actions on disposable repositories', () => {
  it('stages and unstages a literal filename, preserving the working contents', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'stage', path: 'literal[1].txt' }));
    let files = (await get(`/api/repositories/${repo.id}/working`)).body.files as ChangedFile[];
    expect(files.find(f => f.path === 'literal[1].txt')?.scope).toBe('staged');
    expect(files.find(f => f.path === 'literal1.txt')?.scope).toBe('unstaged');
    await successful(repo.action({ action: 'unstage', path: 'literal[1].txt' }));
    expect(await readFile(path.join(repo.root, 'literal[1].txt'), 'utf8')).toBe('literal modified\n');
    await successful(repo.action({ action: 'stage-all' }));
    files = (await get(`/api/repositories/${repo.id}/working`)).body.files;
    expect(files.every(f => f.scope === 'staged')).toBe(true);
    await successful(repo.action({ action: 'unstage-all' }));
    files = (await get(`/api/repositories/${repo.id}/working`)).body.files;
    expect(files.some(f => f.scope === 'staged')).toBe(false);
  });
  it('unstages a newly added file before the first commit without deleting it', async () => {
    const repo = await fresh(true);
    await writeFile(path.join(repo.root, 'first.txt'), 'first\n');
    await successful(repo.action({ action: 'stage', path: 'first.txt' }));
    await writeFile(path.join(repo.root, 'first.txt'), 'working changed\n');
    await successful(repo.action({ action: 'unstage', path: 'first.txt' }));
    expect(await readFile(path.join(repo.root, 'first.txt'), 'utf8')).toBe('working changed\n');
  });
  it('commits only staged changes and treats the message as literal data', async () => {
    const repo = await fresh();
    const message = 'Review $(echo unsafe); literal `text`';
    await successful(repo.action({ action: 'commit', message }));
    expect(await fixtureGit(repo.root, ['log', '-1', '--format=%s'])).toBe(message);
    const files = (await get(`/api/repositories/${repo.id}/working`)).body.files as ChangedFile[];
    expect(files.some(f => f.path === 'src/App.tsx' && f.scope === 'unstaged')).toBe(true);
    expect(files.some(f => f.scope === 'staged')).toBe(false);
  });
  it('saves and restores a stash with untracked files and index state', async () => {
    const repo = await fresh();
    const saved = await successful(repo.action({ action: 'stash-save', message: 'Fixture stash', includeUntracked: true }));
    expect((await get(`/api/repositories/${repo.id}/working`)).body.files, JSON.stringify(saved.body)).toEqual([]);
    const options = (await get(`/api/repositories/${repo.id}/action-options`)).body;
    expect(options.stashes).toHaveLength(1);
    expect(options.stashes[0].ref).toBe('stash@{0}');
    await successful(repo.action({ action: 'stash-pop', stash: 'stash@{0}' }));
    const files = (await get(`/api/repositories/${repo.id}/working`)).body.files as ChangedFile[];
    expect(files.filter(f => f.path === 'both.txt').map(f => f.scope).sort()).toEqual(['staged', 'unstaged']);
    expect(files.find(f => f.path === 'notes with spaces.txt')?.scope).toBe('untracked');
    expect((await get(`/api/repositories/${repo.id}/action-options`)).body.stashes).toEqual([]);
  });
  it('moves a tracked file and discards only unstaged changes', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'rename', path: 'literal[1].txt', target: 'docs/moved.txt' }));
    await expect(access(path.join(repo.root, 'literal[1].txt'))).rejects.toThrow();
    expect(await readFile(path.join(repo.root, 'docs/moved.txt'), 'utf8')).toBe('literal modified\n');
    const reviewed = await discardReview(await repositories.get(repo.id), 'both.txt');
    await successful(repo.action({ action: 'discard', path: 'both.txt', discardFingerprint: reviewed.fingerprint }));
    expect(await readFile(path.join(repo.root, 'both.txt'), 'utf8')).toBe('staged\n');
    expect((await repo.action({ action: 'discard', path: 'empty.txt' })).status).toBe(400);
  });
  it('creates, switches, merges and deletes a branch with real Git commands', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'stage-all' })); await successful(repo.action({ action: 'commit', message: 'Save fixture work' }));
    await successful(repo.action({ action: 'branch-create', target: 'feature/new-note' }));
    await writeFile(path.join(repo.root, 'new-note.md'), 'A branch-specific note\n');
    await successful(repo.action({ action: 'stage', path: 'new-note.md' })); await successful(repo.action({ action: 'commit', message: 'Add note' }));
    await successful(repo.action({ action: 'switch', target: 'main' }));
    await successful(repo.action({ action: 'merge', target: 'feature/new-note' }));
    expect(await readFile(path.join(repo.root, 'new-note.md'), 'utf8')).toContain('branch-specific');
    await successful(repo.action({ action: 'branch-delete', target: 'feature/new-note' }));
    expect((await get(`/api/repositories/${repo.id}/branches`)).body.some((b: { name: string }) => b.name === 'feature/new-note')).toBe(false);
  });
  it('pushes, fetches and pulls through a local bare fixture remote only', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'stage-all' })); await successful(repo.action({ action: 'commit', message: 'Save fixture work' }));
    const remote = path.join(repo.base, 'remote.git'); await mkdir(remote); await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
    await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
    await successful(repo.action({ action: 'push', remote: 'origin' }));
    expect((await get(`/api/repositories/${repo.id}/working`)).body).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    expect(await fixtureGit(remote, ['rev-parse', 'main'])).toBe(await fixtureGit(repo.root, ['rev-parse', 'HEAD']));
    const peer = path.join(repo.base, 'peer');
    await fixtureGit(repo.base, ['clone', '--', remote, peer]);
    await fixtureGit(peer, ['config', 'user.name', 'Fixture Peer']); await fixtureGit(peer, ['config', 'user.email', 'peer@example.invalid']);
    await writeFile(path.join(peer, 'remote-note.md'), 'Only the local fixture remote was contacted.\n');
    await fixtureGit(peer, ['add', '--', 'remote-note.md']); await fixtureGit(peer, ['commit', '-m', 'Remote fixture note']); await fixtureGit(peer, ['push', 'origin', 'main']);
    await successful(repo.action({ action: 'fetch', remote: 'origin' }));
    expect((await get(`/api/repositories/${repo.id}/working`)).body).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 1 });
    await successful(repo.action({ action: 'pull', remote: 'origin' }));
    expect(await readFile(path.join(repo.root, 'remote-note.md'), 'utf8')).toContain('local fixture');
    await writeFile(path.join(repo.root, 'local-note.md'), 'Ahead of the fixture remote\n');
    await successful(repo.action({ action: 'stage', path: 'local-note.md' })); await successful(repo.action({ action: 'commit', message: 'Local note' }));
    expect((await get(`/api/repositories/${repo.id}/working`)).body).toMatchObject({ ahead: 1, behind: 0 });
    await writeFile(path.join(peer, 'peer-note.md'), 'A diverged fixture commit\n');
    await fixtureGit(peer, ['add', '.']); await fixtureGit(peer, ['commit', '-m', 'Peer note']); await fixtureGit(peer, ['push', 'origin', 'main']);
    await successful(repo.action({ action: 'fetch', remote: 'origin' }));
    expect((await get(`/api/repositories/${repo.id}/working`)).body).toMatchObject({ ahead: 1, behind: 1 });
  });
  it('rejects arbitrary operations, extra arguments, path and option injection', async () => {
    const repo = await fresh();
    for (const body of [{ action: 'exec', command: 'anything' }, { action: 'stage', path: '../outside' }, { action: 'stage', path: 'src/App.tsx', args: ['--force'] }, { action: 'merge', target: '--help' }, { action: 'branch-create', target: '--help' }, { action: 'push', remote: 'https://unconfigured.example' }, { action: 'rename', path: 'both.txt', target: '../outside' }, { action: 'stash-pop', stash: '--all' }]) {
      expect((await post(`/api/repositories/${repo.id}/actions`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).post(`/api/repositories/${repo.id}/actions`).set('Host', host).send({ action: 'stage-all' })).status).toBe(403);
  });
  it('cherry-picks and reverts a commit through fixed operations', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'stage-all' })); await successful(repo.action({ action: 'commit', message: 'Save work' }));
    await successful(repo.action({ action: 'branch-create', target: 'feature/pick' }));
    await writeFile(path.join(repo.root, 'picked.txt'), 'Pick this commit\n');
    await successful(repo.action({ action: 'stage', path: 'picked.txt' })); await successful(repo.action({ action: 'commit', message: 'Pickable change' }));
    const commit = await fixtureGit(repo.root, ['rev-parse', 'HEAD']);
    await successful(repo.action({ action: 'switch', target: 'main' }));
    await successful(repo.action({ action: 'cherry-pick', target: commit }));
    expect(await readFile(path.join(repo.root, 'picked.txt'), 'utf8')).toBe('Pick this commit\n');
    await successful(repo.action({ action: 'revert', target: 'HEAD' }));
    await expect(access(path.join(repo.root, 'picked.txt'))).rejects.toThrow();
    expect(await fixtureGit(repo.root, ['log', '-1', '--format=%s'])).toContain('Revert');
  });
  it('stashes before switching and lets the user reapply the exact stash with staging preserved', async () => {
    const repo = await fresh();
    const switched = await successful(repo.action({ action: 'switch', target: 'feature/focus-mode', stashBeforeSwitch: true }));
    expect(switched.body.stashed).toMatchObject({ ref: 'stash@{0}' });
    expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('feature/focus-mode');
    expect((await get(`/api/repositories/${repo.id}/working`)).body.files).toEqual([]);
    const saved = switched.body.stashed;
    await successful(repo.action({ action: 'stash-apply', stash: saved.ref, stashHash: saved.hash }));
    const files = (await get(`/api/repositories/${repo.id}/working`)).body.files as ChangedFile[];
    expect(files.filter(file => file.path === 'both.txt').map(file => file.scope).sort()).toEqual(['staged', 'unstaged']);
    expect(files.find(file => file.path === 'notes with spaces.txt')?.scope).toBe('untracked');
    expect((await get(`/api/repositories/${repo.id}/action-options`)).body.stashes[0].hash).toBe(saved.hash);
    expect((await repo.action({ action: 'stash-apply', stash: saved.ref, stashHash: '0'.repeat(40) })).status).toBe(409);
  });
  it('checks out a remote-tracking branch as a local tracking branch', async () => {
    const repo = await fresh();
    await successful(repo.action({ action: 'stage-all' })); await successful(repo.action({ action: 'commit', message: 'Save work' }));
    const remote = path.join(repo.base, 'remote.git'); await mkdir(remote); await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
    await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
    await fixtureGit(repo.root, ['push', 'origin', 'HEAD:refs/heads/feature/remote-only']);
    await successful(repo.action({ action: 'fetch', remote: 'origin' }));
    await successful(repo.action({ action: 'switch', target: 'origin/feature/remote-only', stashBeforeSwitch: true }));
    expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('feature/remote-only');
    expect((await get(`/api/repositories/${repo.id}/working`)).body).toMatchObject({ upstream: 'origin/feature/remote-only', ahead: 0, behind: 0 });
  });
});
