import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';

const { app } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317';
const cleanup: string[] = [];
let token: string;
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => { for (const root of cleanup) await removeFixture(root); });
const post = (url: string, body: unknown) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object);
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
async function setup(content: string, name = 'story.txt', untracked = false) {
  const fixture = await createFixture(true); cleanup.push(fixture.base);
  const file = path.join(fixture.root, name);
  await writeFile(file, content);
  if (!untracked) { await fixtureGit(fixture.root, ['add', '.']); await fixtureGit(fixture.root, ['commit', '-m', 'Base']); }
  const id = (await post('/api/repositories', { path: fixture.root })).body.id;
  const url = `/api/repositories/${id}`;
  return { ...fixture, file, name, url, diff: (scope: string) => get(url + '/diff?' + new URLSearchParams({ path: name, scope })) };
}
async function selected(repo: Awaited<ReturnType<typeof setup>>, scope: string, action: string, choose: (raw: string, index: number) => boolean, extra = {}) {
  const diff = await repo.diff(scope);
  expect(diff.status, JSON.stringify(diff.body)).toBe(200);
  expect(diff.body.lineActions, JSON.stringify(diff.body)).toBe(true);
  const lines = (diff.body.patch as string).split('\n').flatMap((raw, index) => choose(raw, index) ? [index] : []);
  const response = await post(repo.url + '/lines', { path: repo.name, scope, action, lines, fingerprint: diff.body.fingerprint, ...extra });
  return response;
}
function expectSuccess(response: request.Response) { expect(response.status, JSON.stringify(response.body)).toBe(200); }

describe('selected-line Git apply actions', () => {
  it('stages only one replacement, then unstages it without touching the working file', async () => {
    const repo = await setup('first\nold one\nmiddle\nold two\nlast\n');
    const working = 'first\nnew one\nmiddle\nnew two\nlast\n'; await writeFile(repo.file, working);
    expectSuccess(await selected(repo, 'unstaged', 'stage', raw => raw === '-old one' || raw === '+new one'));
    expect(await fixtureGit(repo.root, ['show', ':story.txt'])).toBe('first\nnew one\nmiddle\nold two\nlast');
    expect(await readFile(repo.file, 'utf8')).toBe(working);
    expectSuccess(await selected(repo, 'staged', 'unstage', raw => raw === '-old one' || raw === '+new one'));
    expect(await fixtureGit(repo.root, ['diff', '--cached'])).toBe('');
    expect(await readFile(repo.file, 'utf8')).toBe(working);
  });
  it('applies partial insertions across distant hunks with correct cumulative offsets', async () => {
    const original = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`);
    const repo = await setup(original.join('\n') + '\n');
    const modified = original.flatMap((line, i) => i === 1 ? [line, 'first added', 'keep first unselected'] : i === 28 ? [line, 'second added', 'keep second unselected'] : [line]);
    await writeFile(repo.file, modified.join('\n') + '\n');
    expectSuccess(await selected(repo, 'unstaged', 'stage', raw => raw === '+first added' || raw === '+second added'));
    const indexed = await fixtureGit(repo.root, ['show', ':story.txt']);
    expect(indexed).toContain('line 2\nfirst added\nline 3'); expect(indexed).toContain('line 29\nsecond added\nline 30'); expect(indexed).not.toContain('unselected');
    expectSuccess(await selected(repo, 'staged', 'unstage', raw => raw === '+first added'));
    expect(await fixtureGit(repo.root, ['show', ':story.txt'])).toBe(original.flatMap((line, i) => i === 28 ? [line, 'second added'] : [line]).join('\n'));
  });
  it('partially stages a new unusual filename and unstages its remaining staged lines', async () => {
    const repo = await setup('one\ntwo\nthree\n', 'new [α] file.txt', true);
    expectSuccess(await selected(repo, 'untracked', 'stage', raw => raw === '+two'));
    expect(await fixtureGit(repo.root, ['show', ':new [α] file.txt'])).toBe('two');
    expect(await readFile(repo.file, 'utf8')).toBe('one\ntwo\nthree\n');
    expectSuccess(await selected(repo, 'staged', 'unstage', raw => raw === '+two'));
    expect(await fixtureGit(repo.root, ['ls-files'])).toBe('');
    expect(await readFile(repo.file, 'utf8')).toBe('one\ntwo\nthree\n');
  });
  it('stages a subset of deletions while leaving the unstaged file deleted', async () => {
    const repo = await setup('one\ntwo\nthree\n'); await unlink(repo.file);
    expectSuccess(await selected(repo, 'unstaged', 'stage', raw => raw === '-two'));
    expect(await fixtureGit(repo.root, ['show', ':story.txt'])).toBe('one\nthree');
    await expect(access(repo.file)).rejects.toThrow();
    expectSuccess(await selected(repo, 'unstaged', 'discard', raw => raw === '-one', { confirmed: true }));
    expect(await readFile(repo.file, 'utf8')).toBe('one\n');
  });
  it('discards selected edits only after confirmation and refuses stale selections', async () => {
    const repo = await setup('before\nold\nafter\n'); await writeFile(repo.file, 'before\nnew\nkeep\nafter\n');
    expect((await selected(repo, 'unstaged', 'discard', raw => raw === '+keep')).body.error.code).toBe('CONFIRM_DISCARD');
    expectSuccess(await selected(repo, 'unstaged', 'discard', raw => raw === '+keep', { confirmed: true }));
    expect(await readFile(repo.file, 'utf8')).toBe('before\nnew\nafter\n');
    const old = (await repo.diff('unstaged')).body;
    await writeFile(repo.file, 'external edit\n');
    const result = await post(repo.url + '/lines', { path: repo.name, scope: 'unstaged', action: 'discard', lines: [5], fingerprint: old.fingerprint, confirmed: true });
    expect(result.body.error.code).toBe('DIFF_CHANGED');
    expect(await readFile(repo.file, 'utf8')).toBe('external edit\n');
  });
  it('preserves no-final-newline and CRLF content', async () => {
    const repo = await setup('old'); await writeFile(repo.file, 'new');
    expectSuccess(await selected(repo, 'unstaged', 'stage', raw => raw === '-old' || raw === '+new'));
    expect(await fixtureGit(repo.root, ['show', ':story.txt'])).toBe('new');
    expectSuccess(await selected(repo, 'staged', 'unstage', raw => raw === '-old' || raw === '+new'));
    expectSuccess(await selected(repo, 'unstaged', 'discard', raw => raw === '-old' || raw === '+new', { confirmed: true }));
    expect(await readFile(repo.file, 'utf8')).toBe('old');
    const crlf = await setup('one\r\nold\r\nlast\r\n'); await writeFile(crlf.file, 'one\r\nnew\r\nlast\r\n');
    expectSuccess(await selected(crlf, 'unstaged', 'discard', raw => raw === '-old\r' || raw === '+new\r', { confirmed: true }));
    expect(await readFile(crlf.file, 'utf8')).toBe('one\r\nold\r\nlast\r\n');
  });
  it('rejects injected patches, traversal, historical scopes and non-change line indexes', async () => {
    const repo = await setup('old\n'); await writeFile(repo.file, 'new\n');
    const data = (await repo.diff('unstaged')).body;
    const payload = { path: repo.name, scope: 'unstaged', action: 'stage', lines: [0], fingerprint: data.fingerprint };
    for (const extra of [{}, { path: '../outside' }, { patch: 'anything' }, { scope: 'commit' }, { lines: [-1] }, { lines: ['5'] }]) expect((await post(repo.url + '/lines', { ...payload, ...extra })).status).toBe(400);
    expect((await request(app).post(repo.url + '/lines').set('Host', host).send(payload)).status).toBe(403);
    expect(await fixtureGit(repo.root, ['diff', '--cached'])).toBe('');
  });
});
