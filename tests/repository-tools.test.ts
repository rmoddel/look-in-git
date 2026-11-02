import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import os from 'node:os';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { git } from '../server/git';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';
import type { RepositoryTools } from '../shared/types';

const { app } = createApp(); app.use(errorHandler);
const host = '127.0.0.1:4317';
const cleanup: string[] = [];
const onboardingCleanup: string[] = [];
let token: string;
beforeAll(async () => { token = (await request(app).get('/api/session').set('Host', host)).body.token; });
afterAll(async () => {
  for (const base of onboardingCleanup) {
    const actual = await realpath(base), tempRoot = await realpath(os.tmpdir()), relative = path.relative(tempRoot, actual);
    if ((await lstat(base)).isSymbolicLink() || path.isAbsolute(relative) || relative.includes(path.sep) || !/^look-in-git-onboarding-[a-z0-9]+$/i.test(relative)) throw new Error('Refusing to remove a non-onboarding fixture folder.');
    await rm(actual, { recursive: true, force: true });
  }
  for (const base of cleanup) await removeFixture(base);
});
async function onboardingParent() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'look-in-git-onboarding-'));
  onboardingCleanup.push(parent); return parent;
}
const readCreatedGit = async (root: string, operation: string, args: string[]) => (await git(root, operation, args)).output.trim();
const post = (url: string, body: unknown) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object);
const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
async function success(pending: PromiseLike<request.Response>) {
  const result = await pending;
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
async function fresh(empty = false) {
  const fixture = await createFixture(empty); cleanup.push(fixture.base);
  const opened = await success(post('/api/repositories', { path: fixture.root }));
  const url = `/api/repositories/${opened.id}/tools`;
  return { ...fixture, id: opened.id as string, tools: () => success(get(url)) as Promise<RepositoryTools>, action: (body: unknown) => post(url, body) };
}
async function bareRemote(repo: Awaited<ReturnType<typeof fresh>>) {
  const remote = path.join(repo.base, 'remote with spaces.git');
  await mkdir(remote); await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
  await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
  await fixtureGit(repo.root, ['push', 'origin', 'main', 'feature/focus-mode', '--tags']);
  return remote;
}

describe('repository onboarding and management through the local API', () => {
  it('initializes only a new folder with the selected initial branch and leaves existing work untouched', async () => {
    const repo = await fresh(), before = await snapshot(repo.root), parent = await onboardingParent();
    const created = await success(post('/api/repositories/create', { kind: 'init', parent, name: 'new project', branch: 'develop' }));
    expect(created.root.toLowerCase()).toBe(path.join(parent, 'new project').toLowerCase());
    expect(await readCreatedGit(created.root, 'symbolic-ref', ['--short', 'HEAD'])).toBe('develop');
    expect((await success(get(`/api/repositories/${created.id}/working`))).files).toEqual([]);
    expect(await snapshot(repo.root)).toBe(before);
  });

  it('clones a chosen branch from a local bare fixture, preserving the source working copy', async () => {
    const repo = await fresh(), remote = await bareRemote(repo), before = await snapshot(repo.root), parent = await onboardingParent();
    const created = await success(post('/api/repositories/create', { kind: 'clone', parent, name: 'clone project', url: remote, branch: 'feature/focus-mode' }));
    expect(await readCreatedGit(created.root, 'rev-parse', ['HEAD'])).toBe(repo.initial);
    expect(await readCreatedGit(created.root, 'symbolic-ref', ['--short', 'HEAD'])).toBe('feature/focus-mode');
    expect(await readCreatedGit(created.root, 'rev-parse', ['--abbrev-ref', '@{upstream}'])).toBe('origin/feature/focus-mode');
    expect((await readFile(path.join(created.root, 'both.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('original\n');
    expect(await snapshot(repo.root)).toBe(before);
  });

  it('rejects unsafe names, existing folders, repository parents, and junction parents', async () => {
    const repo = await fresh(), before = await snapshot(repo.root), parent = await onboardingParent();
    for (const name of ['../outside', '..', '.', '.git', '.GIT', 'nested/name', 'nested\\name', 'CON', 'NUL.txt', 'com1', 'LPT9.log', 'COM¹', 'CONIN$', 'CONOUT$', 'CLOCK$', 'trailing.', 'trailing ', ' leading', 'stream:target', 'wild*name', 'line\nbreak']) {
      const result = await post('/api/repositories/create', { kind: 'init', parent, name });
      expect(result.status, name).toBe(400);
    }
    await mkdir(path.join(parent, 'existing-folder'));
    expect((await post('/api/repositories/create', { kind: 'init', parent, name: 'existing-folder' })).status).toBe(409);
    await writeFile(path.join(parent, 'existing-file'), 'keep this');
    expect((await post('/api/repositories/create', { kind: 'init', parent, name: 'existing-file' })).status).toBe(409);
    expect((await post('/api/repositories/create', { kind: 'init', parent: repo.root, name: 'nested' })).body.error.code).toBe('PARENT_IS_REPOSITORY');
    expect((await post('/api/repositories/create', { kind: 'init', parent: parent + path.sep + '..', name: 'outside' })).status).toBe(400);
    const plain = path.join(parent, 'plain-parent'), link = path.join(parent, 'junction-parent');
    await mkdir(plain); await symlink(plain, link, 'junction');
    expect((await post('/api/repositories/create', { kind: 'init', parent: link, name: 'unsafe' })).status).toBe(403);
    expect(await readdir(plain)).toEqual([]);
    expect(await snapshot(repo.root)).toBe(before);
  });

  it('rejects embedded credentials, arbitrary helpers, traversal and extra creation arguments before creating a folder', async () => {
    const repo = await fresh(), parent = await onboardingParent();
    const urls = ['https://user:password@example.invalid/repo.git', 'https://token@example.invalid/repo.git', 'https://example.invalid/repo.git?token=secret', 'https://example.invalid/repo.git#fragment', 'ssh://git:password@example.invalid/repo.git', 'ssh://-host/repo.git', 'ssh://git@example.invalid/repo%0acommand', 'ext::whoami', 'file:///outside', 'http://example.invalid/repo.git', 'ftp://example.invalid/repo.git', '--upload-pack=unsafe', '../source', 'git@host:-option', 'git@host:repo.git\ncommand'];
    for (const url of urls) {
      const result = await post('/api/repositories/create', { kind: 'clone', parent, name: 'invalid-clone', url });
      expect(result.status, url).toBe(400);
    }
    expect((await post('/api/repositories/create', { kind: 'init', parent, name: 'invalid-clone', branch: '--help' })).status).toBe(400);
    expect((await post('/api/repositories/create', { kind: 'init', parent, name: 'invalid-clone', args: ['--bare'] })).status).toBe(400);
    expect((await post('/api/repositories/create', { kind: 'init', parent, name: 'invalid-clone', url: repo.root })).status).toBe(400);
    await expect(access(path.join(parent, 'invalid-clone'))).rejects.toThrow();
  });

  it('retains a failed clone folder and identifies its exact path without deleting source files', async () => {
    const repo = await fresh(), source = path.join(repo.base, 'not-a-repository'), parent = await onboardingParent();
    await mkdir(source); await writeFile(path.join(source, 'keep.txt'), 'preserve');
    const result = await post('/api/repositories/create', { kind: 'clone', parent, name: 'failed-clone', url: source });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('REPOSITORY_CREATE_FAILED');
    expect(result.body.error.message).toContain(path.join(parent, 'failed-clone'));
    await access(path.join(parent, 'failed-clone'));
    expect(await readFile(path.join(source, 'keep.txt'), 'utf8')).toBe('preserve');
  });

  it('reports identity, tags and explicit policies while redacting remote URL credentials and query secrets', async () => {
    const repo = await fresh();
    await fixtureGit(repo.root, ['remote', 'add', 'private', 'https://private-user:TOP_SECRET@example.invalid/team/repo.git?token=QUERY_SECRET']);
    await fixtureGit(repo.root, ['remote', 'set-url', '--add', '--push', 'private', 'https://PUSH_SECRET@example.invalid/team/repo.git#FRAGMENT_SECRET']);
    const info = await repo.tools();
    expect(info.identity).toEqual({ name: 'Alex Morgan', email: 'fixture@example.invalid' });
    expect(info.policy).toEqual({ hooksEnabled: false, signingEnabled: false });
    expect(info.tags).toContainEqual(expect.objectContaining({ name: 'v0.1.0', hash: repo.initial, annotated: false }));
    expect(info.remotes[0]).toMatchObject({ name: 'private', fetchUrls: ['https://example.invalid/team/repo.git'], pushUrls: ['https://example.invalid/team/repo.git'] });
    expect(info.remotes[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(info)).not.toMatch(/TOP_SECRET|QUERY_SECRET|PUSH_SECRET|FRAGMENT_SECRET|private-user/);
  });

  it('adds and edits remote configuration without networking, with stale-review checks and explicit push URLs preserved', async () => {
    const repo = await fresh();
    await success(repo.action({ action: 'remote-add', name: 'origin', url: 'git@example.invalid:team/repository.git' }));
    expect((await repo.action({ action: 'remote-add', name: 'origin', url: 'https://example.invalid/repo.git' })).status).toBe(409);
    const first = (await repo.tools()).remotes[0];
    await fixtureGit(repo.root, ['remote', 'set-url', '--add', '--push', 'origin', 'ssh://git@example.invalid/team/push.git']);
    expect((await repo.action({ action: 'remote-set-url', name: 'origin', url: 'https://example.invalid/team/fetch.git', expectedFingerprint: first.fingerprint })).status).toBe(409);
    expect((await repo.action({ action: 'remote-remove', name: 'origin', expectedFingerprint: first.fingerprint })).status).toBe(409);
    const current = (await repo.tools()).remotes[0];
    await success(repo.action({ action: 'remote-set-url', name: 'origin', url: 'https://example.invalid/team/fetch.git', expectedFingerprint: current.fingerprint }));
    const updated = (await repo.tools()).remotes[0];
    expect(updated.fetchUrls).toEqual(['https://example.invalid/team/fetch.git']);
    expect(updated.pushUrls).toEqual(['ssh://example.invalid/team/push.git']);
    expect(updated.fingerprint).not.toBe(current.fingerprint);
    await success(repo.action({ action: 'remote-remove', name: 'origin', expectedFingerprint: updated.fingerprint }));
    expect((await repo.tools()).remotes).toEqual([]);
  });

  it('removes only local remote configuration and tracking refs, leaving the local bare host intact', async () => {
    const repo = await fresh(), remote = await bareRemote(repo);
    const head = await fixtureGit(remote, ['rev-parse', 'refs/heads/main']);
    const current = (await repo.tools()).remotes[0];
    await success(repo.action({ action: 'remote-remove', name: 'origin', expectedFingerprint: current.fingerprint }));
    expect(await fixtureGit(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])).toBe('');
    expect(await fixtureGit(remote, ['rev-parse', 'refs/heads/main'])).toBe(head);
  });

  it('creates annotated and lightweight local tags and rejects stale deletes without changing remote tags', async () => {
    const repo = await fresh(), remote = await bareRemote(repo);
    await success(repo.action({ action: 'tag-create', name: 'release/one', target: 'HEAD', message: 'Release $(whoami); literal `text`' }));
    await success(repo.action({ action: 'tag-create', name: 'checkpoint', target: repo.initial }));
    const info = await repo.tools(), annotation = info.tags.find(tag => tag.name === 'release/one')!;
    expect(annotation).toMatchObject({ annotated: true, subject: 'Release $(whoami); literal `text`' });
    expect(annotation.hash).not.toBe(repo.latest);
    expect(info.tags.find(tag => tag.name === 'checkpoint')).toMatchObject({ annotated: false, hash: repo.initial });
    expect((await repo.action({ action: 'tag-create', name: 'checkpoint', target: 'HEAD' })).status).toBe(409);
    await fixtureGit(repo.root, ['push', 'origin', 'refs/tags/release/one']);
    await fixtureGit(repo.root, ['tag', '-f', 'checkpoint', repo.latest]);
    expect((await repo.action({ action: 'tag-delete', name: 'checkpoint', expectedHash: repo.initial })).status).toBe(409);
    expect(await fixtureGit(repo.root, ['rev-parse', 'refs/tags/checkpoint'])).toBe(repo.latest);
    await success(repo.action({ action: 'tag-delete', name: 'release/one', expectedHash: annotation.hash }));
    expect((await repo.tools()).tags.some(tag => tag.name === 'release/one')).toBe(false);
    expect(await fixtureGit(remote, ['rev-parse', 'refs/tags/release/one'])).toBe(annotation.hash);
  });

  it('sets upstream and renames a local branch while preserving commits, working edits and remote branch names', async () => {
    const repo = await fresh(), remote = await bareRemote(repo);
    const status = await fixtureGit(repo.root, ['status', '--porcelain=v1', '-z']);
    await success(repo.action({ action: 'upstream-set', target: 'refs/remotes/origin/main' }));
    await success(repo.action({ action: 'branch-rename', target: 'refs/heads/main', newName: 'feature/renamed' }));
    expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('feature/renamed');
    expect(await fixtureGit(repo.root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main');
    expect(await fixtureGit(repo.root, ['rev-parse', 'HEAD'])).toBe(repo.latest);
    expect(await fixtureGit(repo.root, ['status', '--porcelain=v1', '-z'])).toBe(status);
    expect(await fixtureGit(remote, ['rev-parse', 'refs/heads/main'])).toBe(repo.latest);
    expect((await repo.action({ action: 'branch-rename', target: 'feature/renamed', newName: 'feature/focus-mode' })).status).toBe(409);
    expect((await repo.action({ action: 'upstream-set', target: 'origin/main' })).status).toBe(400);
  });

  it('enforces the API boundary and fixed argument schemas for management operations', async () => {
    const repo = await fresh(), url = `/api/repositories/${repo.id}/tools`, before = await snapshot(repo.root);
    expect((await request(app).post(url).set('Host', host).send({ action: 'tag-create', name: 'unsafe', target: 'HEAD' })).status).toBe(403);
    expect((await request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).set('Origin', 'https://outside.example').send({ action: 'tag-create', name: 'unsafe', target: 'HEAD' })).status).toBe(403);
    for (const body of [
      { action: 'exec', command: 'whoami' }, { action: 'remote-add', name: '--help', url: repo.root },
      { action: 'remote-add', name: 'safe', url: 'ext::whoami' }, { action: 'remote-add', name: 'safe', url: 'https://token@example.invalid/repo.git' },
      { action: 'remote-add', name: 'safe', url: repo.root, args: ['--mirror'] }, { action: 'tag-create', name: '--help', target: 'HEAD' },
      { action: 'tag-create', name: 'test', target: '--all' }, { action: 'tag-create', name: 'refs/heads/unsafe', target: 'HEAD' },
      { action: 'branch-rename', target: 'main', newName: '--help' }, { action: 'branch-rename', target: 'refs/remotes/origin/main', newName: 'safe' },
    ]) expect((await repo.action(body)).status, JSON.stringify(body)).toBe(400);
    expect(await snapshot(repo.root)).toBe(before);
  });
});
