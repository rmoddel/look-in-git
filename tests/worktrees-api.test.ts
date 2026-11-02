import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { parseWorktreePorcelain } from '../server/worktrees';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';

const host = '127.0.0.1:4317';
const { app } = createApp(); app.use(errorHandler);
const cleanups: string[] = [];
let token = '';
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const folder of cleanups) await removeFixture(folder); });
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
const post = (url: string, body: unknown) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object);
async function fixture() {
  const data = await createFixture(); cleanups.push(data.base);
  const opened = await post('/api/repositories', { path: data.root }); expect(opened.status).toBe(200);
  return { ...data, endpoint: `/api/repositories/${opened.body.id}/worktrees` };
}
const act = (endpoint: string, body: unknown) => post(`${endpoint}/action`, body);

describe('native worktree API', () => {
  it('parses NUL-delimited records with spaces, newlines, detached heads, and lock metadata', () => {
    const raw = [
      'worktree C:/code/repo with spaces', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree C:/code/feature\nwith\ttabs', 'HEAD def456', 'detached', 'locked in use by Codex\nagent', '',
    ].join('\0') + '\0';
    expect(parseWorktreePorcelain(raw)).toEqual([
      { path: 'C:/code/repo with spaces', head: 'abc123', branchRef: 'refs/heads/main', detached: false, locked: false, lockReason: '', prunable: false, prunableReason: '' },
      { path: 'C:/code/feature\nwith\ttabs', head: 'def456', branchRef: '', detached: true, locked: true, lockReason: 'in use by Codex\nagent', prunable: false, prunableReason: '' },
    ]);
  });

  it('discovers main and linked worktrees with independent dirty status and NUL-safe paths', async () => {
    const repo = await fixture(), linked = path.join(repo.base, 'linked with spaces');
    await fixtureGit(repo.root, ['worktree', 'add', '-b', 'feature/side-tree', '--', linked, 'HEAD']);
    await writeFile(path.join(linked, 'untracked file.txt'), 'new\n');
    const response = await get(repo.endpoint);
    expect(response.status).toBe(200);
    expect(response.body.find((tree: { main: boolean }) => tree.main)).toMatchObject({ path: repo.root, branch: 'main', dirty: true });
    expect(response.body.find((tree: { path: string }) => tree.path === linked)).toMatchObject({ name: 'linked with spaces', branch: 'feature/side-tree', dirty: true, untracked: 1, detached: false, main: false });
  });

  it('creates a branch worktree from a base and creates from an existing branch', async () => {
    const repo = await fixture(), first = path.join(repo.base, 'new branch tree'), second = path.join(repo.base, 'existing branch tree');
    const created = await act(repo.endpoint, { action: 'create', path: first, newBranch: 'feature/new-tree', base: 'HEAD' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.worktrees.some((tree: { path: string; branch: string }) => tree.path === first && tree.branch === 'feature/new-tree')).toBe(true);
    const existing = await act(repo.endpoint, { action: 'create', path: second, branch: 'feature/focus-mode', base: 'HEAD' });
    expect(existing.status, JSON.stringify(existing.body)).toBe(200);
    expect(existing.body.worktrees.some((tree: { path: string; branch: string }) => tree.path === second && tree.branch === 'feature/focus-mode')).toBe(true);
  });

  it('locks/unlocks linked trees and requires explicit clean removal confirmation', async () => {
    const repo = await fixture(), linked = path.join(repo.base, 'removable tree');
    await fixtureGit(repo.root, ['worktree', 'add', '-b', 'feature/removable', '--', linked, 'HEAD']);
    expect((await act(repo.endpoint, { action: 'lock', path: linked })).status).toBe(200);
    expect((await get(repo.endpoint)).body.find((tree: { path: string }) => tree.path === linked).locked).toBe(true);
    expect((await act(repo.endpoint, { action: 'unlock', path: linked })).status).toBe(200);
    expect((await act(repo.endpoint, { action: 'remove', path: linked })).status).toBe(400);
    await writeFile(path.join(linked, 'unsaved.txt'), 'keep me');
    const dirty = await act(repo.endpoint, { action: 'remove', path: linked, confirm: true });
    expect(dirty.status).toBe(409); expect(dirty.body.error.code).toBe('DIRTY_WORKTREE');
    expect(await fixtureGit(linked, ['status', '--porcelain'])).toContain('unsaved.txt');
    await fixtureGit(linked, ['clean', '-fd']);
    const removed = await act(repo.endpoint, { action: 'remove', path: linked, confirm: true });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.worktrees.some((tree: { path: string }) => tree.path === linked)).toBe(false);
    expect(await fixtureGit(repo.root, ['show-ref', '--verify', 'refs/heads/feature/removable'])).toContain('refs/heads/feature/removable');
  });

  it('blocks a branch already checked out elsewhere and rejects traversal/unknown parameters', async () => {
    const repo = await fixture(), linked = path.join(repo.base, 'occupied');
    await fixtureGit(repo.root, ['worktree', 'add', '-b', 'feature/occupied', '--', linked, 'HEAD']);
    expect((await act(repo.endpoint, { action: 'create', path: path.join(repo.base, 'duplicate'), branch: 'feature/occupied' })).status).toBe(422);
    expect((await act(repo.endpoint, { action: 'create', path: `${repo.base}/../escape`, newBranch: 'feature/escape' })).status).toBe(400);
    const nested = await act(repo.endpoint, { action: 'create', path: path.join(repo.root, 'nested-worktree'), newBranch: 'feature/nested' });
    expect(nested.status).toBe(400); expect(nested.body.error.code).toBe('OVERLAPPING_WORKTREE_PATH');
    expect((await act(repo.endpoint, { action: 'prune', confirm: true, command: 'clean' })).status).toBe(400);
  });

  it('deletes a worktree branch only with a separate opt-in after Git confirms it is merged', async () => {
    const repo = await fixture(), linked = path.join(repo.base, 'delete branch tree');
    await fixtureGit(repo.root, ['worktree', 'add', '-b', 'feature/delete-after-review', '--', linked, 'HEAD']);
    const result = await act(repo.endpoint, { action: 'remove', path: linked, confirm: true, deleteBranch: true });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.summary).toContain('deleted the merged branch');
    expect(await fixtureGit(repo.root, ['branch', '--list', 'feature/delete-after-review'])).toBe('');
  });

  it('moves clean linked worktrees and keeps the main worktree immovable', async () => {
    const repo = await fixture(), linked = path.join(repo.base, 'before move'), target = path.join(repo.base, 'after move');
    await fixtureGit(repo.root, ['worktree', 'add', '-b', 'feature/movable', '--', linked, 'HEAD']);
    const main = await act(repo.endpoint, { action: 'move', path: repo.root, target });
    expect(main.status).toBe(409);
    const moved = await act(repo.endpoint, { action: 'move', path: linked, target });
    // Some Windows Git/filesystem combinations reject directory moves with
    // ERROR_ACCESS_DENIED. In that case Git must leave its source worktree intact.
    if (moved.status === 200) expect(moved.body.worktrees.some((tree: { path: string }) => tree.path === target)).toBe(true);
    else { expect(moved.status).toBe(422); expect(moved.body.error.code).toBe('WORKTREE_MOVE_FAILED'); expect((await get(repo.endpoint)).body.some((tree: { path: string }) => tree.path === linked)).toBe(true); }
  });

  it('requires explicit confirmation for metadata repair and prune', async () => {
    const repo = await fixture();
    expect((await act(repo.endpoint, { action: 'repair' })).status).toBe(400);
    expect((await act(repo.endpoint, { action: 'prune' })).status).toBe(400);
    expect((await act(repo.endpoint, { action: 'repair', confirm: true })).status).toBe(200);
    expect((await act(repo.endpoint, { action: 'prune', confirm: true })).status).toBe(200);
  });
});
