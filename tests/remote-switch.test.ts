import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';

const { app } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317', cleanup: string[] = [];
const target = 'feature/remote-only', ref = `refs/remotes/origin/${target}`;
let token: string;
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const root of cleanup) await removeFixture(root); });
const post = (url: string, body: object) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body);
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
async function fresh(dirty = true) {
  const repo = await createFixture(!dirty); cleanup.push(repo.base);
  if (!dirty) {
    await writeFile(path.join(repo.root, 'base.txt'), 'Base\n');
    await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', 'Base']);
  }
  const remote = path.join(repo.base, 'remote.git'); await mkdir(remote); await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
  await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
  await fixtureGit(repo.root, ['push', 'origin', `HEAD:refs/heads/${target}`]);
  const peer = path.join(repo.base, 'peer');
  await fixtureGit(repo.base, ['clone', '--branch', target, '--', remote, peer]);
  await fixtureGit(peer, ['config', 'user.name', 'Fixture Peer']); await fixtureGit(peer, ['config', 'user.email', 'peer@example.invalid']);
  const opened = await post('/api/repositories', { path: repo.root }); expect(opened.status).toBe(200);
  const url = `/api/repositories/${opened.body.id}`;
  return { ...repo, remote, peer, url, action: (body: object) => post(url + '/actions', body) };
}
async function advance(repo: Awaited<ReturnType<typeof fresh>>) {
  await writeFile(path.join(repo.peer, 'remote-note.md'), 'Fresh content from the local fixture remote\n');
  await fixtureGit(repo.peer, ['add', '.']); await fixtureGit(repo.peer, ['commit', '-m', 'New remote work']); await fixtureGit(repo.peer, ['push', 'origin', target]);
  return fixtureGit(repo.peer, ['rev-parse', 'HEAD']);
}
const state = (repo: Awaited<ReturnType<typeof fresh>>) => fixtureGit(repo.root, ['status', '--porcelain=v1', '-z']);

it('fetches the latest remote tip, stashes dirty work, creates a local branch, and reapplies exact index state', async () => {
  const repo = await fresh();
  const before = await state(repo), originalHead = await fixtureGit(repo.root, ['rev-parse', 'HEAD']);
  await fixtureGit(repo.root, ['branch', `origin/${target}`]); // Ambiguous short ref must not select this local branch.
  const latest = await advance(repo);
  expect(await fixtureGit(repo.root, ['rev-parse', ref])).not.toBe(latest);
  const result = await repo.action({ action: 'switch', target: ref });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body).toMatchObject({ switchedBranch: target, stashed: { ref: 'stash@{0}' } });
  expect(result.body.commands.map((command: string[]) => command[1])).toEqual(['fetch', 'stash', 'switch']);
  expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(latest);
  expect(await fixtureGit(repo.root, ['rev-parse', 'main'])).toBe(originalHead);
  expect(await fixtureGit(repo.root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).toBe(ref);
  expect(await state(repo)).toBe('');
  expect((await repo.action({ action: 'stash-apply', stash: result.body.stashed.ref, stashHash: result.body.stashed.hash })).status).toBe(200);
  expect(await state(repo)).toBe(before);
  expect(await readFile(path.join(repo.root, 'both.txt'), 'utf8')).toBe('working\n');
});

it('fast-forwards an existing tracking branch after fetching instead of leaving it stale', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['branch', '--track', target, ref]);
  const latest = await advance(repo);
  const result = await repo.action({ action: 'switch', target: ref });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.commands.some((command: string[]) => command[1] === 'merge' && command.includes('--ff-only'))).toBe(true);
  expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(latest);
  expect((await get(repo.url + '/working')).body).toMatchObject({ branch: target, ahead: 0, behind: 0 });
});

it('keeps local-only commits and refuses divergence before stashing or switching', async () => {
  const repo = await fresh(false);
  await fixtureGit(repo.root, ['switch', '--track', '-c', target, ref]);
  await writeFile(path.join(repo.root, 'local.txt'), 'Only local\n'); await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', 'Local work']);
  const localHead = await fixtureGit(repo.root, ['rev-parse', 'HEAD']);
  await fixtureGit(repo.root, ['switch', 'main']);
  let result = await repo.action({ action: 'switch', target: ref });
  expect(result.status).toBe(200);
  expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(localHead);
  expect(result.body.summary).toContain('Kept 1 local-only commit');
  await fixtureGit(repo.root, ['switch', 'main']); await advance(repo);
  await writeFile(path.join(repo.root, 'dirty.txt'), 'Do not move this work\n');
  const before = await state(repo);
  result = await repo.action({ action: 'switch', target: ref });
  expect(result.body.error.code).toBe('BRANCH_DIVERGED');
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
  expect(await state(repo)).toBe(before);
  expect((await get(repo.url + '/action-options')).body.stashes).toEqual([]);
});

it('does not repoint a same-name local branch that tracks a different remote branch', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['push', 'origin', 'HEAD:refs/heads/other']);
  await fixtureGit(repo.root, ['branch', '--track', target, 'origin/other']);
  const before = await state(repo);
  const result = await repo.action({ action: 'switch', target: ref });
  expect(result.body.error.code).toBe('DIFFERENT_UPSTREAM');
  expect(await state(repo)).toBe(before);
  expect(await fixtureGit(repo.root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${target}`])).toBe('refs/remotes/origin/other');
});

it('leaves local changes alone when fetching the remote fails', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['remote', 'set-url', 'origin', path.join(repo.base, 'missing-remote.git')]);
  const before = await state(repo);
  const result = await repo.action({ action: 'switch', target: ref });
  expect(result.status).toBe(422);
  expect(await state(repo)).toBe(before);
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
  expect((await get(repo.url + '/action-options')).body.stashes).toEqual([]);
});

it('blocks a remote target checked out in another worktree before fetching or stashing', async () => {
  const repo = await fresh();
  await fixtureGit(repo.root, ['branch', '--track', target, ref]);
  const occupied = path.join(repo.base, 'occupied [remote] caf\u00e9');
  await fixtureGit(repo.root, ['worktree', 'add', occupied, target]);
  const originalTracking = await fixtureGit(repo.root, ['rev-parse', ref]);
  const latest = await advance(repo);
  expect(latest).not.toBe(originalTracking);
  const status = await state(repo), before = await snapshot(repo.base);
  const result = await repo.action({ action: 'switch', target: ref });
  expect(result.status, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error.code).toBe('BRANCH_IN_WORKTREE');
  expect(result.body.error.message).toContain('Nothing was fetched, stashed, or switched.');
  expect(result.body.error.recovery.stashed).toBeUndefined();
  expect(result.body.error.recovery.worktree.branch).toBe(target);
  expect(path.resolve(result.body.error.recovery.worktree.path)).toBe(occupied);
  // Includes the index, refs, reflogs, FETCH_HEAD, objects and every working file.
  expect(await snapshot(repo.base)).toBe(before);
  expect(await fixtureGit(repo.root, ['rev-parse', ref])).toBe(originalTracking);
  expect(await state(repo)).toBe(status);
  expect((await get(repo.url + '/action-options')).body.stashes).toEqual([]);
  const available = await get(repo.url + '/branches');
  expect(available.status).toBe(200);
  const branch = available.body.find((item: { name: string; remote: boolean }) => item.name === target && !item.remote);
  expect(path.resolve(branch.worktreePath)).toBe(occupied);
});

it('blocks direct local-branch checkout before stashing and preserves staged, unstaged and untracked files', async () => {
  const repo = await fresh();
  const occupied = path.join(repo.base, process.platform === 'win32' ? 'local [worktree] caf\u00e9' : 'local [worktree]\n caf\u00e9');
  const localTarget = 'feature/focus-mode';
  await fixtureGit(repo.root, ['worktree', 'add', occupied, localTarget]);
  const status = await state(repo), before = await snapshot(repo.base);
  const result = await repo.action({ action: 'switch', target: `refs/heads/${localTarget}`, stashBeforeSwitch: true });
  expect(result.status, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error.code).toBe('BRANCH_IN_WORKTREE');
  expect(result.body.error.recovery.worktree.branch).toBe(localTarget);
  expect(path.resolve(result.body.error.recovery.worktree.path)).toBe(occupied);
  expect(await snapshot(repo.base)).toBe(before);
  expect(await state(repo)).toBe(status);
  expect(await fixtureGit(repo.root, ['show', ':both.txt'])).toBe('staged');
  expect(await readFile(path.join(repo.root, 'both.txt'), 'utf8')).toBe('working\n');
  expect(await readFile(path.join(repo.root, 'notes with spaces.txt'), 'utf8')).toContain('Untracked note');
});

it('prevents switching a linked worktree to main occupied by the original worktree', async () => {
  const repo = await fresh();
  const linked = path.join(repo.base, 'linked [working copy]');
  await fixtureGit(repo.root, ['worktree', 'add', linked, 'feature/focus-mode']);
  await writeFile(path.join(linked, 'both.txt'), 'linked staged\n');
  await fixtureGit(linked, ['add', '--', 'both.txt']);
  await writeFile(path.join(linked, 'both.txt'), 'linked unstaged\n');
  await writeFile(path.join(linked, 'new linked.txt'), 'linked untracked\n');
  const opened = await post('/api/repositories', { path: linked });
  expect(opened.status).toBe(200);
  const url = `/api/repositories/${opened.body.id}`;
  const available = await get(url + '/action-options');
  const main = available.body.branches.find((item: { name: string }) => item.name === 'main');
  expect(main.current).toBe(false);
  expect(path.resolve(main.worktreePath)).toBe(repo.root);
  const before = await snapshot(repo.base);
  const result = await post(url + '/actions', { action: 'switch', target: 'refs/heads/main', stashBeforeSwitch: true });
  expect(result.status, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error.code).toBe('BRANCH_IN_WORKTREE');
  expect(result.body.error.recovery.worktree.branch).toBe('main');
  expect(path.resolve(result.body.error.recovery.worktree.path)).toBe(repo.root);
  expect(await snapshot(repo.base)).toBe(before);
  expect(await fixtureGit(linked, ['branch', '--show-current'])).toBe('feature/focus-mode');
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
});

it('reviews and merges a remote branch into local through the supported API routes', async () => {
  const repo = await fresh(false);
  const latest = await advance(repo);
  expect((await repo.action({ action: 'fetch', remote: 'origin' })).status).toBe(200);
  await fixtureGit(repo.root, ['branch', `origin/${target}`]);
  const review = await get(repo.url + '/action-review?' + new URLSearchParams({ action: 'merge', target: ref }));
  expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect(review.body).toMatchObject({ source: `origin/${target}`, destination: 'main', incoming: 1 });
  const merged = await repo.action({ action: 'merge', target: ref, reviewFingerprint: review.body.fingerprint });
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
  expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(latest);
});
