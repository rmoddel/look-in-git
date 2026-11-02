import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';
import type { Commit, ReflogEntry, StashPreview } from '../shared/types';

const host = '127.0.0.1:4317';
const { app } = createApp();
app.use(errorHandler);
let token = '', id = '', stashHash = '', detailHash = '', sideHash = '', before = '';
let fixture: Awaited<ReturnType<typeof createFixture>>;
const specialPath = 'docs/history [literal] café.md';
const renamedPath = 'docs/renamed [literal] café.md';
function get(resource: string, query: Record<string, string> = {}) {
  return request(app).get(`/api/repositories/${id}/${resource}?${new URLSearchParams(query)}`).set('Host', host).set('X-Look-in-Git-Token', token);
}

beforeAll(async () => {
  fixture = await createFixture();
  await fixtureGit(fixture.root, ['stash', 'push', '--include-untracked', '-m', 'Inspect staged, unstaged and untracked']);
  stashHash = await fixtureGit(fixture.root, ['rev-parse', 'refs/stash']);
  await writeFile(path.join(fixture.root, specialPath), 'Literal path history\n');
  await fixtureGit(fixture.root, ['add', '--', specialPath]);
  await fixtureGit(fixture.root, ['commit', '--author=Robin Example <robin@example.invalid>', '--date=2001-02-03T04:05:06Z', '-m', 'Explain history [a-z].* literally', '-m', 'First body paragraph.\n\nFind this needle ONLY inside the body.\nShell-looking text: $(whoami); --all']);
  detailHash = await fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
  await rename(path.join(fixture.root, specialPath), path.join(fixture.root, renamedPath));
  await fixtureGit(fixture.root, ['add', '--all', '--', 'docs']);
  await fixtureGit(fixture.root, ['commit', '-m', 'Rename the literal history path']);
  await fixtureGit(fixture.root, ['switch', '-c', 'research/only', fixture.initial]);
  await writeFile(path.join(fixture.root, 'research.txt'), 'Reachable only from another branch\n');
  await fixtureGit(fixture.root, ['add', '--', 'research.txt']);
  await fixtureGit(fixture.root, ['commit', '-m', 'Research outside current branch']);
  sideHash = await fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
  await fixtureGit(fixture.root, ['update-ref', 'refs/remotes/demo/research', sideHash]);
  await fixtureGit(fixture.root, ['switch', 'main']);
  token = (await request(app).get('/api/session').set('Host', host)).body.token;
  const opened = await request(app).post('/api/repositories').set('Host', host).set('X-Look-in-Git-Token', token).send({ path: fixture.root });
  expect(opened.status).toBe(200);
  id = opened.body.id;
  before = await snapshot(fixture.root);
});
afterAll(async () => { if (fixture) await removeFixture(fixture.base); });

describe('history search and commit details', () => {
  it('searches the complete message literally and combines an explicit author filter', async () => {
    for (const q of ['[a-z].*', 'needle only', '$(whoami); --all']) {
      const found = await get('history', { q });
      expect(found.status).toBe(200);
      expect(found.body.commits.map((commit: Commit) => commit.hash)).toEqual([detailHash]);
    }
    expect((await get('history', { q: 'needle', author: 'robin example' })).body.commits).toHaveLength(1);
    expect((await get('history', { q: 'needle', author: 'Alex' })).body.commits).toEqual([]);
    expect((await get('history', { author: '.*' })).body.commits).toEqual([]);
    expect((await get('history', { q: '--all' })).body.commits).toHaveLength(1);
  });

  it('scopes history to a branch or all branches without including stash commits', async () => {
    const current = await get('history');
    expect(current.body.commits[0].refs).toContain('HEAD -> main');
    expect(current.body.commits.map((commit: Commit) => commit.hash)).not.toContain(sideHash);
    const other = await get('history', { ref: 'refs/remotes/demo/research' });
    expect(other.body.commits.map((commit: Commit) => commit.hash)).toEqual([sideHash, fixture.initial]);
    const all = await get('history', { ref: 'all' });
    expect(all.body.commits.map((commit: Commit) => commit.hash)).toContain(sideHash);
    expect(all.body.commits.map((commit: Commit) => commit.hash)).not.toContain(stashHash);
  });

  it('finds full and abbreviated commit IDs within the selected scope', async () => {
    expect((await get('history', { q: detailHash })).body.commits.map((commit: Commit) => commit.hash)).toEqual([detailHash]);
    expect((await get('history', { q: detailHash.slice(0, 9) })).body.commits.map((commit: Commit) => commit.hash)).toEqual([detailHash]);
    expect((await get('history', { q: sideHash })).body.commits).toEqual([]);
    expect((await get('history', { q: sideHash, ref: 'all' })).body.commits).toHaveLength(1);
    expect((await get('history', { q: detailHash, offset: '50' })).body.commits).toEqual([]);
  });

  it('follows a literal renamed path and rejects invalid revisions and traversal', async () => {
    const result = await get('history', { path: renamedPath });
    expect(result.status).toBe(200);
    expect(result.body.commits).toHaveLength(2);
    expect(result.body.commits[1].hash).toBe(detailHash);
    expect((await get('history', { path: 'literal[1].txt' })).body.commits).toHaveLength(1);
    for (const unsafe of ['../secret', '.git/config', 'C:/Windows/win.ini']) expect((await get('history', { path: unsafe })).status).toBe(400);
    for (const ref of ['--all', 'HEAD\n--all', 'missing']) expect((await get('history', { ref })).status).toBe(400);
    expect((await get('history', { q: 'one\ntwo' })).status).toBe(400);
    expect((await get('history', { offset: '-1' })).status).toBe(400);
  });

  it('returns body, author, committer, parents and decorations without losing paragraphs', async () => {
    const result = await get('commit', { ref: detailHash });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ hash: detailHash, subject: 'Explain history [a-z].* literally', author: 'Robin Example', email: 'robin@example.invalid', committer: 'Alex Morgan', committerEmail: 'fixture@example.invalid', parents: [fixture.latest] });
    expect(result.body.body).toBe('First body paragraph.\n\nFind this needle ONLY inside the body.\nShell-looking text: $(whoami); --all');
    expect(result.body.date).toMatch(/^2001-02-03/);
    expect(result.body.committedDate).not.toMatch(/^2001-02-03/);
    expect((await get('commit', { ref: 'main' })).body.decorations).toContain('main');
    expect((await get('commit', { ref: '--output=anything' })).status).toBe(400);
  });
});

describe('recovery inspection', () => {
  it('shows reflog event time rather than the historical commit author date', async () => {
    const result = await get('reflog');
    expect(result.status).toBe(200);
    const entries = result.body.entries as ReflogEntry[];
    expect(entries[0].selector).toBe('HEAD@{0}');
    const oldAuthored = entries.find(entry => entry.hash === detailHash && entry.subject.startsWith('commit:'))!;
    expect(oldAuthored).toBeDefined();
    expect(oldAuthored.date).not.toMatch(/^2001-02-03/);
    const actual = await fixtureGit(fixture.root, ['log', '-g', '--date=iso-strict', '--format=%gD', '--max-count=1', `--skip=${entries.indexOf(oldAuthored)}`, 'HEAD']);
    expect(oldAuthored.date).toBe(actual.match(/@\{(.+)\}$/)?.[1]);
    expect(Number.isNaN(Date.parse(oldAuthored.date))).toBe(false);
    expect((await get('reflog', { offset: '1' })).body.entries[0].selector).toBe('HEAD@{1}');
    expect((await get('reflog', { offset: '--all' })).status).toBe(400);
  });

  it('previews staged, unstaged and untracked stash trees using immutable hashes', async () => {
    const result = await get('stash', { hash: stashHash });
    expect(result.status).toBe(200);
    const preview = result.body as StashPreview;
    expect(preview.stash.hash).toBe(stashHash);
    expect(preview.staged.files.find(file => file.path === 'both.txt')).toMatchObject({ scope: 'compare', status: 'M' });
    expect(preview.unstaged.files.find(file => file.path === 'both.txt')).toMatchObject({ scope: 'compare', status: 'M' });
    expect(preview.untracked?.from).toBeNull();
    expect(preview.untracked?.files.find(file => file.path === 'notes with spaces.txt')).toMatchObject({ scope: 'commit', status: 'A' });
    for (const [comparison, expected] of [[preview.staged, '-original\n+staged'], [preview.unstaged, '-staged\n+working']] as const) {
      const diff = await get('diff', { scope: 'compare', path: 'both.txt', from: comparison.from!, to: comparison.to });
      expect(diff.status).toBe(200);
      expect(diff.body.patch).toContain(expected);
    }
    const untracked = await get('diff', { scope: 'commit', path: 'notes with spaces.txt', to: preview.untracked!.to });
    expect(untracked.body.patch).toContain('+Untracked note');
    expect((await get('stash', { hash: fixture.latest })).status).toBe(404);
    expect((await get('stash', { hash: 'stash@{0}' })).status).toBe(400);
  });

  it('keeps the working tree, index and all Git metadata byte-for-byte unchanged', async () => {
    expect(await snapshot(fixture.root)).toBe(before);
  });

  it('rejects a linked path before searching history', async () => {
    const isolated = await createFixture(true);
    try {
      const outside = path.join(isolated.base, 'outside');
      await mkdir(outside);
      await symlink(outside, path.join(isolated.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const opened = await request(app).post('/api/repositories').set('Host', host).set('X-Look-in-Git-Token', token).send({ path: isolated.root });
      const result = await request(app).get(`/api/repositories/${opened.body.id}/history?path=linked/private.txt`).set('Host', host).set('X-Look-in-Git-Token', token);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('SYMLINK_PATH');
    } finally { await removeFixture(isolated.base); }
  });

  it('returns empty history and reflog for a repository with no commits', async () => {
    const isolated = await createFixture(true);
    try {
      const opened = await request(app).post('/api/repositories').set('Host', host).set('X-Look-in-Git-Token', token).send({ path: isolated.root });
      for (const resource of ['history', 'history?ref=all', 'reflog']) {
        const result = await request(app).get(`/api/repositories/${opened.body.id}/${resource}`).set('Host', host).set('X-Look-in-Git-Token', token);
        expect(result.status).toBe(200);
        expect(result.body[resource.startsWith('history') ? 'commits' : 'entries']).toEqual([]);
        expect(result.body.hasMore).toBe(false);
      }
    } finally { await removeFixture(isolated.base); }
  });

  it('paginates beyond 50 results without dropping or duplicating commits', async () => {
    const isolated = await createFixture(true);
    try {
      await fixtureGit(isolated.root, ['commit', '--allow-empty', '-m', 'Page 0']);
      const tree = await fixtureGit(isolated.root, ['rev-parse', 'HEAD^{tree}']);
      let previous = await fixtureGit(isolated.root, ['rev-parse', 'HEAD']);
      for (let index = 1; index <= 51; index++) previous = await fixtureGit(isolated.root, ['commit-tree', tree, '-p', previous, '-m', `Page ${index}`]);
      await fixtureGit(isolated.root, ['update-ref', 'refs/heads/main', previous]);
      const opened = await request(app).post('/api/repositories').set('Host', host).set('X-Look-in-Git-Token', token).send({ path: isolated.root });
      const page = (offset: number) => request(app).get(`/api/repositories/${opened.body.id}/history?q=Page&offset=${offset}`).set('Host', host).set('X-Look-in-Git-Token', token);
      const first = (await page(0)).body, second = (await page(50)).body;
      expect(first.commits).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      expect(second.commits).toHaveLength(2);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.commits, ...second.commits].map((commit: Commit) => commit.hash)).size).toBe(52);
    } finally { await removeFixture(isolated.base); }
  }, 60000);
});
