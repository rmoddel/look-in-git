import { afterAll, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';
import { Repositories } from '../server/repositories';
import { actionOptions, executeAction, withWriteLock } from '../server/actions';
import { reviewAction } from '../server/action-review';
import { discardReview } from '../server/discard-review';
import { lineAction } from '../server/line-actions';
import { saveMerge } from '../server/merge';
import { gitErrorMessage, redactGitOutput } from '../server/diagnostics';

const cleanup: string[] = [];
const repositories = new Repositories();
afterAll(async () => { for (const base of cleanup) await removeFixture(base); });
async function fresh(dirty = false) {
  const fixture = await createFixture(!dirty); cleanup.push(fixture.base);
  if (!dirty) {
    await writeFile(path.join(fixture.root, 'base.txt'), 'base\n');
    await fixtureGit(fixture.root, ['add', '.']); await fixtureGit(fixture.root, ['commit', '-m', 'Base']);
  }
  const opened = await repositories.open(fixture.root);
  return { ...fixture, ctx: await repositories.get(opened.id) };
}
async function withRemote() {
  const repo = await fresh();
  const remote = path.join(repo.base, 'remote.git'); await mkdir(remote);
  await fixtureGit(remote, ['init', '--bare', '-b', 'release/integration']);
  await fixtureGit(repo.root, ['remote', 'add', 'origin', remote]);
  await fixtureGit(repo.root, ['push', '-u', 'origin', 'HEAD:refs/heads/release/integration']);
  return { ...repo, remote };
}

it('pushes and pulls the configured differently named upstream without changing tracking', async () => {
  const repo = await withRemote();
  expect((await actionOptions(repo.ctx)).upstream).toEqual({ remote: 'origin', branch: 'release/integration' });
  await writeFile(path.join(repo.root, 'local.txt'), 'local\n');
  await fixtureGit(repo.root, ['add', '.']); await fixtureGit(repo.root, ['commit', '-m', 'Local']);
  const preview = await reviewAction(repo.ctx, { action: 'push', remote: 'origin' });
  expect(preview).toMatchObject({ destination: 'origin/release/integration', remoteBranch: 'release/integration', outgoing: 1 });
  const pushed = await executeAction(repo.ctx, { action: 'push', remote: 'origin', reviewFingerprint: preview.fingerprint });
  expect(pushed.command).toContain('HEAD:refs/heads/release/integration');
  expect(pushed.command).not.toContain('--set-upstream');
  expect(await fixtureGit(repo.remote, ['branch', '--format=%(refname)'])).toBe('refs/heads/release/integration');
  const peer = path.join(repo.base, 'peer');
  await fixtureGit(repo.base, ['clone', '--branch', 'release/integration', '--', repo.remote, peer]);
  await fixtureGit(peer, ['config', 'user.name', 'Fixture Peer']); await fixtureGit(peer, ['config', 'user.email', 'peer@example.invalid']);
  await writeFile(path.join(peer, 'peer.txt'), 'peer\n');
  await fixtureGit(peer, ['add', '.']); await fixtureGit(peer, ['commit', '-m', 'Peer']); await fixtureGit(peer, ['push']);
  const pulled = await executeAction(repo.ctx, { action: 'pull', remote: 'origin' });
  expect(pulled.command.at(-1)).toBe('refs/heads/release/integration');
  expect(await readFile(path.join(repo.root, 'peer.txt'), 'utf8')).toBe('peer\n');
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
  expect(await fixtureGit(repo.root, ['config', '--get', 'branch.main.merge'])).toBe('refs/heads/release/integration');
});

it('uses an explicit destination while preserving an existing upstream', async () => {
  const repo = await withRemote();
  const preview = await reviewAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: 'review/alternate' });
  expect(preview).toMatchObject({ destination: 'origin/review/alternate', remoteBranch: 'review/alternate' });
  expect(preview.warnings.join(' ')).toContain('preserves the existing upstream');
  const result = await executeAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: 'review/alternate', reviewFingerprint: preview.fingerprint });
  expect(result.command).not.toContain('--set-upstream');
  expect(await fixtureGit(repo.remote, ['rev-parse', 'refs/heads/review/alternate'])).toBe(await fixtureGit(repo.root, ['rev-parse', 'HEAD']));
  expect(await fixtureGit(repo.root, ['config', '--get', 'branch.main.merge'])).toBe('refs/heads/release/integration');
  await expect(executeAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: '--all' })).rejects.toMatchObject({ code: 'INVALID_BRANCH' });
});

it('sets an upstream only for an untracked branch and reads tracking even when the ref is missing', async () => {
  const repo = await withRemote();
  await fixtureGit(repo.root, ['branch', '--unset-upstream']);
  const result = await executeAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: 'published/main' });
  expect(result.command).toContain('--set-upstream');
  await fixtureGit(repo.root, ['update-ref', '-d', 'refs/remotes/origin/published/main']);
  expect((await actionOptions(repo.ctx)).upstream).toEqual({ remote: 'origin', branch: 'published/main' });
  expect(await reviewAction(repo.ctx, { action: 'push', remote: 'origin' })).toMatchObject({ destination: 'origin/published/main', incoming: null, outgoing: null });
});

it('rejects a stale network review when upstream changes even if the explicit destination stays the same', async () => {
  const repo = await withRemote();
  const preview = await reviewAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: 'same-destination' });
  await fixtureGit(repo.root, ['config', 'branch.main.merge', 'refs/heads/another']);
  await expect(executeAction(repo.ctx, { action: 'push', remote: 'origin', remoteBranch: 'same-destination', reviewFingerprint: preview.fingerprint })).rejects.toMatchObject({ code: 'ACTION_CHANGED' });
  expect(await fixtureGit(repo.remote, ['branch', '--format=%(refname)'])).toBe('refs/heads/release/integration');
});

it('requires a current discard review and catches changed file contents or index content', async () => {
  const repo = await fresh(true);
  await expect(executeAction(repo.ctx, { action: 'discard', path: 'both.txt' })).rejects.toMatchObject({ code: 'DISCARD_REVIEW_REQUIRED' });
  let review = await discardReview(repo.ctx, 'both.txt');
  await writeFile(path.join(repo.root, 'both.txt'), 'newer edit\n');
  await expect(executeAction(repo.ctx, { action: 'discard', path: 'both.txt', discardFingerprint: review.fingerprint })).rejects.toMatchObject({ code: 'DISCARD_CHANGED' });
  review = await discardReview(repo.ctx, 'both.txt');
  await writeFile(path.join(repo.root, 'both.txt'), 'different staging\n'); await fixtureGit(repo.root, ['add', '--', 'both.txt']);
  await writeFile(path.join(repo.root, 'both.txt'), 'newer edit\n');
  await expect(executeAction(repo.ctx, { action: 'discard', path: 'both.txt', discardFingerprint: review.fingerprint })).rejects.toMatchObject({ code: 'DISCARD_CHANGED' });
  expect(await readFile(path.join(repo.root, 'both.txt'), 'utf8')).toBe('newer edit\n');
});

it('reviews and restores binary and deleted files while refusing oversized discard previews', async () => {
  const repo = await fresh(true);
  for (const name of ['binary.bin', 'legacy.config.json']) {
    const review = await discardReview(repo.ctx, name);
    expect(review.deleted).toBe(name === 'legacy.config.json');
    await executeAction(repo.ctx, { action: 'discard', path: name, discardFingerprint: review.fingerprint });
  }
  expect(await readFile(path.join(repo.root, 'binary.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
  expect(await readFile(path.join(repo.root, 'legacy.config.json'), 'utf8')).toContain('classic');
  await writeFile(path.join(repo.root, 'both.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await expect(discardReview(repo.ctx, 'both.txt')).rejects.toMatchObject({ code: 'DISCARD_TOO_LARGE' });
  await expect(discardReview(repo.ctx, '../outside')).rejects.toMatchObject({ code: 'INVALID_PATH' });
});

it('serializes actions, line writes and merge writes across linked worktrees', async () => {
  const repo = await fresh();
  const linked = path.join(repo.base, 'linked');
  await fixtureGit(repo.root, ['worktree', 'add', '-b', 'linked-branch', linked]);
  const opened = await repositories.open(linked), linkedCtx = await repositories.get(opened.id);
  expect(linkedCtx.repo.root).not.toBe(repo.ctx.repo.root);
  expect(linkedCtx.lockKey).toBe(repo.ctx.lockKey);
  let release!: () => void;
  const held = withWriteLock(repo.ctx.lockKey, () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await expect(executeAction(linkedCtx, { action: 'branch-recover', target: 'recovery', message: 'HEAD' })).rejects.toMatchObject({ code: 'ACTION_RUNNING' });
    await expect(lineAction(linkedCtx, { action: 'stage', path: 'base.txt', scope: 'unstaged', lines: [1], fingerprint: 'test' })).rejects.toMatchObject({ code: 'ACTION_RUNNING' });
    await expect(saveMerge(linkedCtx, {})).rejects.toMatchObject({ code: 'ACTION_RUNNING' });
  } finally { release(); await held; }
});

it('creates recovery branches at a reviewed commit without switching or disturbing local edits', async () => {
  const repo = await fresh(true);
  const status = await fixtureGit(repo.root, ['status', '--porcelain=v1', '-z']);
  const contents = await readFile(path.join(repo.root, 'both.txt'));
  const result = await executeAction(repo.ctx, { action: 'branch-recover', target: 'recovery/earlier', message: repo.initial });
  expect(result.command.slice(0, 3)).toEqual(['git', 'branch', '--']);
  expect(await fixtureGit(repo.root, ['rev-parse', 'recovery/earlier'])).toBe(repo.initial);
  expect(await fixtureGit(repo.root, ['branch', '--show-current'])).toBe('main');
  expect(await fixtureGit(repo.root, ['status', '--porcelain=v1', '-z'])).toBe(status);
  expect(await readFile(path.join(repo.root, 'both.txt'))).toEqual(contents);
});

it('redacts URL credentials, query secrets and authorization values from diagnostics', () => {
  const output = redactGitOutput('fatal: https://private-user:private-token@example.invalid/repo?token=query-secret#fragment Authorization: Bearer header-secret password=plain-secret ssh://private-user@example.invalid/repo?secret=ssh-secret');
  expect(output).toContain('https://example.invalid/repo');
  expect(output).toContain('ssh://example.invalid/repo');
  for (const secret of ['private-user', 'private-token', 'query-secret', 'fragment', 'header-secret', 'plain-secret', 'ssh-secret']) expect(output).not.toContain(secret);
  expect(gitErrorMessage('GH013: protected branch')).toContain('changing credentials does not bypass');
  expect(gitErrorMessage('fatal: Authentication failed')).toContain('configured credential helper');
});
