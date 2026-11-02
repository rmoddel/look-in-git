import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, writeFile, symlink, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';
import type { ChangedFile } from '../shared/types';

async function directoryLink(target: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try { await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); return; }
    catch (error) {
      // Windows can retain a just-renamed directory handle for a moment.
      if (attempt >= 4 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

const host = '127.0.0.1:4317';
const { app } = createApp();
app.use(errorHandler);
let fixture: Awaited<ReturnType<typeof createFixture>>;
let token = '', id = '', before = '';
function get(url: string) { return request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token); }
function post(url: string, body: unknown) { return request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object); }
function diff(scope: string, file: string, extra: Record<string, string> = {}) { return get(`/api/repositories/${id}/diff?${new URLSearchParams({ scope, path: file, ...extra })}`); }

beforeAll(async () => {
  fixture = await createFixture();
  before = await snapshot(fixture.root);
  token = (await request(app).get('/api/session').set('Host', host)).body.token;
  const opened = await post('/api/repositories', { path: fixture.root });
  expect(opened.status).toBe(200);
  id = opened.body.id;
});
afterAll(async () => { if (fixture) await removeFixture(fixture.base); });

describe('local request boundary', () => {
  it('blocks hostile hosts, browser origins, cross-site fetches, and missing tokens', async () => {
    // A normal top-level navigation from another page can load the static app.
    expect((await request(app).get('/').set('Host', host).set('Sec-Fetch-Site', 'cross-site')).status).not.toBe(403);
    expect((await request(app).get('/api/session').set('Host', 'evil.example')).status).toBe(403);
    expect((await request(app).get('/api/session').set('Host', host).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).get('/api/session').set('Host', host).set('Origin', 'null')).status).toBe(403);
    expect((await request(app).get('/api/session').set('Host', host).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).get(`/api/repositories/${id}/working`).set('Host', host)).status).toBe(403);
    expect((await get(`/api/repositories/${id}/working`).set('Origin', `http://${host}`)).status).toBe(200);
  });
  it('rejects arbitrary command routes; mutations use the typed actions endpoint', async () => {
    for (const operation of ['commit', 'stage', 'reset', 'checkout', 'clean', 'pull', 'push', 'command']) expect((await post(`/api/repositories/${id}/${operation}`, { command: 'anything' })).status).toBe(404);
    expect((await post(`/api/repositories/${id}/merge`, { command: 'anything' })).status).toBe(400);
  });
  it('validates every repository lookup and rejects invalid input', async () => {
    expect((await get('/api/repositories/unknown/working')).status).toBe(404);
    expect((await post('/api/repositories', { path: '..' })).status).toBe(400);
    expect((await post('/api/repositories', { path: '\\\\server\\share' })).status).toBe(400);
    expect((await post('/api/repositories', { path: fixture.base })).status).toBe(422);
    expect((await get(`/api/repositories/${id}/history?offset=--all`)).status).toBe(400);
    expect((await diff('execute', 'README.md')).status).toBe(400);
  });
});

describe('Git reads', () => {
  it('opens subdirectories and .git folders as the same repository', async () => {
    expect((await post('/api/repositories', { path: path.join(fixture.root, 'src') })).body.id).toBe(id);
    expect((await post('/api/repositories', { path: path.join(fixture.root, '.git') })).body.id).toBe(id);
  });
  it('discovers repositories in the requested local folder', async () => {
    const result = await post('/api/discover', { path: fixture.base });
    expect(result.status).toBe(200);
    expect(result.body.roots).toContain(await realpath(fixture.root));
  });
  it('shows staged, unstaged, renamed, deleted, untracked and binary files with counts', async () => {
    const result = await get(`/api/repositories/${id}/working`);
    expect(result.status).toBe(200);
    expect(result.body.branch).toBe('main');
    const files = result.body.files as ChangedFile[];
    expect(files.filter(f => f.path === 'both.txt').map(f => f.scope).sort()).toEqual(['staged', 'unstaged']);
    expect(files.find(f => f.path === 'docs/getting started.md')).toMatchObject({ oldPath: 'docs/old-guide.md', status: 'R', scope: 'staged', added: 0, deleted: 0 });
    expect(files.find(f => f.path === 'legacy.config.json')).toMatchObject({ status: 'D', deleted: 1 });
    expect(files.find(f => f.path === 'notes with spaces.txt')).toMatchObject({ scope: 'untracked', added: 2 });
    expect(files.find(f => f.path === 'binary.bin')).toMatchObject({ binary: true, added: null });
  });
  it('shows separate index and working diffs and literal filename pathspecs', async () => {
    const staged = await diff('staged', 'both.txt'), working = await diff('unstaged', 'both.txt');
    expect(staged.body.patch).toContain('-original\n+staged');
    expect(working.body.patch).toContain('-staged\n+working');
    const literal = await diff('unstaged', 'literal[1].txt');
    expect(literal.body.patch).toContain('+literal modified');
    expect(literal.body.patch).not.toContain('other modified');
  });
  it('shows untracked content, binary and empty states', async () => {
    expect((await diff('untracked', 'notes with spaces.txt')).body.patch).toContain('+Untracked note');
    expect((await diff('untracked', 'empty.txt')).body.message).toContain('empty');
    expect((await diff('unstaged', 'binary.bin')).body.binary).toBe(true);
    expect((await diff('unstaged', 'README.md')).status).toBe(404);
  });
  it('returns history, branches, initial commits, and arbitrary comparisons', async () => {
    const history = await get(`/api/repositories/${id}/history`);
    expect(history.body.commits).toHaveLength(2);
    expect(history.body.commits[0]).toMatchObject({ hash: fixture.latest, author: 'Alex Morgan' });
    const branches = await get(`/api/repositories/${id}/branches`);
    expect(branches.body.find((b: { name: string }) => b.name === 'main').current).toBe(true);
    const initial = await get(`/api/repositories/${id}/comparison?scope=commit&to=${fixture.initial}`);
    expect(initial.status).toBe(200);
    expect(initial.body.from).toBeNull();
    expect(initial.body.files.find((f: ChangedFile) => f.path === 'README.md').status).toBe('A');
    expect((await diff('commit', 'README.md', { to: fixture.initial })).body.patch).toContain('+# Fieldnotes');
    const compare = await get(`/api/repositories/${id}/comparison?scope=compare&from=v0.1.0&to=main`);
    expect(compare.body.files).toHaveLength(1);
    expect(compare.body.files[0]).toMatchObject({ path: 'README.md', added: 2 });
    expect((await diff('compare', 'README.md', { from: fixture.initial, to: fixture.latest })).body.patch).toContain('+Made for focused work.');
    expect((await get(`/api/repositories/${id}/comparison?scope=compare&from=main&to=main`)).body.files).toEqual([]);
  });
  it('rejects option injection, traversal, metadata paths and unchanged paths', async () => {
    for (const unsafe of ['../secret', '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'src/../../secret', 'a\0b', 'src/.git/config']) expect((await diff('unstaged', unsafe)).status).toBe(400);
    for (const ref of ['--output=stolen', 'missing-ref', 'HEAD\n--all']) {
      const result = await get(`/api/repositories/${id}/comparison?${new URLSearchParams({ scope: 'compare', from: 'HEAD', to: ref })}`);
      expect(result.status).toBe(400);
    }
  });
  it('leaves the entire working tree and .git metadata byte-for-byte unchanged', async () => {
    expect(await snapshot(fixture.root)).toBe(before);
  });
});

describe('edge cases in isolated fixtures', () => {
  it('handles unborn repositories and detached HEAD', async () => {
    const empty = await createFixture(true);
    try {
      await writeFile(path.join(empty.root, 'first.txt'), 'first\n');
      const opened = await post('/api/repositories', { path: empty.root });
      expect((await get(`/api/repositories/${opened.body.id}/working`)).body.files[0].scope).toBe('untracked');
      expect((await get(`/api/repositories/${opened.body.id}/history`)).body.commits).toEqual([]);
      await fixtureGit(empty.root, ['add', '--', 'first.txt']);
      expect((await get(`/api/repositories/${opened.body.id}/working`)).body.files[0].scope).toBe('staged');
      await fixtureGit(empty.root, ['commit', '-m', 'First']);
      await fixtureGit(empty.root, ['checkout', '--detach']);
      expect((await get(`/api/repositories/${opened.body.id}/working`)).body.branch).toContain('Detached');
    } finally { await removeFixture(empty.base); }
  });
  it('caps large untracked previews and does not claim an exact line total', async () => {
    const local = await createFixture(true);
    try {
      await writeFile(path.join(local.root, 'large.txt'), 'A long line of text\n'.repeat(100000));
      const opened = await post('/api/repositories', { path: local.root });
      const result = await get(`/api/repositories/${opened.body.id}/diff?scope=untracked&path=large.txt`);
      expect(result.status).toBe(200);
      expect(result.body.truncated).toBe(true);
      expect(result.body.patch.length).toBeLessThan(1100000);
      expect((await get(`/api/repositories/${opened.body.id}/working`)).body.files[0].added).toBeNull();
    } finally { await removeFixture(local.base); }
  });
  it('blocks symlink/junction traversal, including repository-root replacement', async () => {
    const local = await createFixture(true);
    try {
      const outside = path.join(local.base, 'outside');
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.txt'), 'do not expose');
      await directoryLink(outside, path.join(local.root, 'escape'));
      const opened = await post('/api/repositories', { path: local.root });
      const rejected = await get(`/api/repositories/${opened.body.id}/diff?scope=untracked&path=escape/secret.txt`);
      expect(rejected.status).toBe(403);
      expect(rejected.body.error.code).toBe('SYMLINK_PATH');
      const moved = path.join(local.base, 'moved');
      await rename(local.root, moved);
      await directoryLink(moved, local.root);
      expect((await get(`/api/repositories/${opened.body.id}/working`)).status).toBe(409);
    } finally { await removeFixture(local.base); }
  });
  it('disables clean/process filters, fsmonitor, textconv and external diffs', async () => {
    const local = await createFixture();
    try {
      const marker = path.join(local.root, 'helper-was-run');
      const helper = path.join(local.base, 'helper.cjs');
      await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'); process.exit(1);`);
      const command = `"${process.execPath.replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`;
      for (const key of ['core.fsmonitor', 'diff.external', 'diff.unsafe.command', 'diff.unsafe.textconv', 'filter.unsafe.clean', 'filter.unsafe.process']) await fixtureGit(local.root, ['config', key, command]);
      await fixtureGit(local.root, ['config', 'filter.unsafe.required', 'true']);
      await writeFile(path.join(local.root, '.gitattributes'), '*.txt filter=unsafe diff=unsafe\n');
      const opened = await post('/api/repositories', { path: local.root });
      const result = await get(`/api/repositories/${opened.body.id}/working`);
      expect(result.status).toBe(200);
      const patch = await get(`/api/repositories/${opened.body.id}/diff?scope=unstaged&path=both.txt`);
      expect(patch.status).toBe(200);
      const { access } = await import('node:fs/promises');
      await expect(access(marker)).rejects.toThrow();
    } finally { await removeFixture(local.base); }
  });
});
