import path from 'node:path';
import { access } from 'node:fs/promises';
import { git } from './git.js';
import { AppError } from './errors.js';
import { stringValue, relativePath, validateFilePath } from './paths.js';
import { parseStatus } from './parsers.js';
import { branches, resolveRef } from './service.js';
import { reviewAction } from './action-review.js';
import { switchBranch } from './switch-branch.js';
import { branchRef } from '../shared/branches.js';
import { configuredUpstream, networkTarget } from './network-target.js';
import { discardReview } from './discard-review.js';
import { redactGitOutput } from './diagnostics.js';
import type { Context } from './repositories.js';
import type { ActionKind, ActionOptions, ActionRequest, ActionResult, Stash } from '../shared/types.js';

const actions = new Set<ActionKind>(['stage', 'unstage', 'stage-all', 'unstage-all', 'commit', 'stash-save', 'stash-apply', 'stash-pop', 'fetch', 'pull', 'push', 'merge', 'squash', 'rebase', 'switch', 'branch-create', 'branch-recover', 'branch-delete', 'rename', 'discard', 'cherry-pick', 'revert', 'merge-abort', 'rebase-abort', 'cherry-pick-abort', 'revert-abort', 'rebase-continue', 'cherry-pick-continue', 'revert-continue']);
const busyRoots = new Set<string>();
export async function withWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  if (busyRoots.has(root)) throw new AppError(409, 'ACTION_RUNNING', 'A Git action is already running for this repository.');
  busyRoots.add(root);
  try { return await operation(); } finally { busyRoots.delete(root); }
}
const run = (ctx: Context, op: string, args: string[], extra = {}) => git(ctx.repo.root, op, args, { config: ctx.config, ...extra });
export async function actionOptions(ctx: Context): Promise<ActionOptions> {
  const [remote, refs, stashResult, branch, gitDirectory] = await Promise.all([
    run(ctx, 'remote', []), branches(ctx),
    run(ctx, 'log', ['-g', '-z', '--no-show-signature', '--format=%gd%x00%H%x00%gs%x00%aI', '--max-count=100', 'refs/stash', '--'], { acceptedCodes: [128] }),
    run(ctx, 'symbolic-ref', ['--quiet', '--short', 'HEAD'], { acceptedCodes: [1] }),
    run(ctx, 'rev-parse', ['--absolute-git-dir']),
  ]);
  const fields = stashResult.output.split('\0');
  const stashes: Stash[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) stashes.push({ ref: fields[i].replace(/^refs\//, ''), hash: fields[i + 1], subject: fields[i + 2], date: fields[i + 3] });
  const gitDir = gitDirectory.output.replace(/\r?\n$/, '');
  async function exists(name: string) { try { await access(path.join(gitDir, name)); return true; } catch { return false; } }
  return { remotes: remote.output.split(/\r?\n/).filter(Boolean), branches: refs, stashes, branch: branch.output.trim(), upstream: await configuredUpstream(ctx, branch.output.trim()), mergeInProgress: await exists('MERGE_HEAD'), rebaseInProgress: await exists('rebase-merge') || await exists('rebase-apply'), cherryPickInProgress: await exists('CHERRY_PICK_HEAD'), revertInProgress: await exists('REVERT_HEAD') };
}

function request(value: unknown): ActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_ACTION', 'Choose a Git action.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['action', 'path', 'target', 'message', 'remote', 'remoteBranch', 'includeUntracked', 'stash', 'stashHash', 'stashBeforeSwitch', 'reviewFingerprint', 'discardFingerprint'].includes(key))) throw new AppError(400, 'INVALID_ACTION', 'Unknown action parameter.');
  if (!actions.has(input.action as ActionKind)) throw new AppError(400, 'INVALID_ACTION', 'This Git action is unavailable.');
  if (input.includeUntracked !== undefined && typeof input.includeUntracked !== 'boolean') throw new AppError(400, 'INVALID_ACTION', 'Invalid untracked-file option.');
  if (input.stashBeforeSwitch !== undefined && (typeof input.stashBeforeSwitch !== 'boolean' || input.action !== 'switch')) throw new AppError(400, 'INVALID_ACTION', 'Stash-before-switch is only available when switching branches.');
  if (input.reviewFingerprint !== undefined && (typeof input.reviewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.reviewFingerprint) || !['merge', 'squash', 'push', 'pull'].includes(String(input.action)))) throw new AppError(400, 'INVALID_ACTION', 'Invalid action review. Reopen the action and review it again.');
  if (input.remoteBranch !== undefined && (!['push', 'pull'].includes(String(input.action)) || typeof input.remoteBranch !== 'string')) throw new AppError(400, 'INVALID_ACTION', 'A remote branch can only be selected for push or pull.');
  if (input.discardFingerprint !== undefined && (input.action !== 'discard' || typeof input.discardFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.discardFingerprint))) throw new AppError(400, 'INVALID_ACTION', 'Invalid file discard review. Review the file again.');
  return input as unknown as ActionRequest;
}

export async function executeAction(ctx: Context, input: unknown): Promise<ActionResult> {
  const body = request(input);
  return withWriteLock(ctx.lockKey, async () => {
    const review = body.reviewFingerprint || body.action === 'squash' ? await reviewAction(ctx, body) : null;
    if (body.reviewFingerprint && review?.fingerprint !== body.reviewFingerprint) throw new AppError(409, 'ACTION_CHANGED', 'The branch, selected revision, remote configuration, or file status changed after this review. Refresh the review before running it.');
    if (review?.blocked) throw new AppError(409, 'ACTION_BLOCKED', review.blocked);
    const state = parseStatus((await run(ctx, 'status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all'])).output);
    let operation: string = '';
    let args: string[] = [];
    let network = false;
    async function changedPaths(staged: boolean, single?: unknown) {
      const name = single === undefined ? undefined : relativePath(single);
      const entries = state.filter(e => (!name || e.path === name) && (staged ? ![' ', '?', '!'].includes(e.index) : e.worktree !== ' ' || e.conflict));
      if (!entries.length) throw new AppError(409, 'NOTHING_TO_DO', staged ? 'There are no matching staged changes.' : 'There are no matching unstaged changes.');
      const paths = [...new Set(entries.flatMap(e => [e.path, ...(e.oldPath && (staged || /[RC]/.test(e.worktree)) ? [e.oldPath] : [])]))];
      for (const name of paths) await validateFilePath(ctx.repo.root, name);
      return paths;
    }
    async function unstage(paths: string[]) {
      const head = await run(ctx, 'rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] });
      operation = head.code === 0 ? 'restore' : 'rm';
      args = head.code === 0 ? ['--staged', '--', ...paths] : ['--cached', '-f', '--ignore-unmatch', '--', ...paths];
    }
    if (body.action === 'stage' || body.action === 'stage-all') {
      operation = 'add'; args = ['--all', '--', ...await changedPaths(false, body.action === 'stage' ? stringValue(body.path, 'File path') : undefined)];
    } else if (body.action === 'unstage' || body.action === 'unstage-all') {
      await unstage(await changedPaths(true, body.action === 'unstage' ? stringValue(body.path, 'File path') : undefined));
    } else if (body.action === 'commit') {
      const message = stringValue(body.message, 'Commit message', 10000);
      if (!message.trim()) throw new AppError(400, 'INVALID_MESSAGE', 'Enter a commit message.');
      operation = 'commit'; args = ['--no-gpg-sign', '-m', message];
    } else if (body.action === 'stash-save') {
      operation = 'stash'; args = ['push', ...(body.includeUntracked ? ['--include-untracked'] : []), '-m', body.message ? stringValue(body.message, 'Stash message', 1000) : 'Saved with Look-in-Git'];
    } else if (body.action === 'stash-apply' || body.action === 'stash-pop') {
      const stash = stringValue(body.stash, 'Stash', 80);
      const selected = (await actionOptions(ctx)).stashes.find(s => s.ref === stash);
      if (!/^stash@\{\d+\}$/.test(stash) || !selected) throw new AppError(400, 'INVALID_STASH', 'Select an existing stash.');
      if (body.stashHash && body.stashHash !== selected.hash) throw new AppError(409, 'STASH_CHANGED', 'The stash list changed. Select your saved stash again.');
      operation = 'stash'; args = [body.action === 'stash-pop' ? 'pop' : 'apply', '--index', stash];
    } else if (['fetch', 'pull', 'push'].includes(body.action)) {
      const options = await actionOptions(ctx);
      const remote = stringValue(body.remote, 'Remote', 200);
      if (remote.startsWith('-') || !options.remotes.includes(remote)) throw new AppError(400, 'INVALID_REMOTE', 'Choose an existing configured remote.');
      if (body.action !== 'fetch' && !options.branch) throw new AppError(409, 'DETACHED_HEAD', 'Switch to a local branch before pushing or pulling.');
      operation = body.action; network = true;
      const destination = body.action === 'fetch' ? null : await networkTarget(ctx, body, options.branch);
      args = body.action === 'fetch' ? ['--no-recurse-submodules', '--', remote] : body.action === 'pull' ? ['--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules', '--', remote, `refs/heads/${destination!.remoteBranch}`] : ['--porcelain', ...(destination!.setUpstream ? ['--set-upstream'] : []), '--no-follow-tags', '--recurse-submodules=no', '--signed=false', '--', remote, `HEAD:refs/heads/${destination!.remoteBranch}`];
    } else if (['merge', 'squash', 'rebase', 'cherry-pick', 'revert'].includes(body.action)) {
      const target = await resolveRef(ctx, body.target);
      operation = body.action === 'squash' ? 'merge' : body.action;
      args = body.action === 'squash' ? ['--squash', '--no-commit', '--no-autostash', '--no-gpg-sign', target] : body.action === 'merge' ? ['--ff', '--commit', '--no-squash', '--no-autostash', '--no-edit', '--no-gpg-sign', target] : body.action === 'rebase' ? ['--no-autostash', '--no-gpg-sign', target] : ['--no-edit', '--no-gpg-sign', target];
    } else if (body.action === 'switch' || body.action === 'branch-delete') {
      const name = stringValue(body.target, 'Branch', 300);
      const refs = await branches(ctx);
      const branch = refs.find(b => branchRef(b) === name) ?? refs.find(b => b.name === name && !b.remote) ?? refs.find(b => b.name === name);
      if (name.startsWith('-') || !branch || body.action === 'branch-delete' && branch.remote) throw new AppError(400, 'INVALID_BRANCH', 'Select an existing branch; only local branches can be deleted.');
      if (body.action === 'switch') return switchBranch(ctx, branch, !!body.stashBeforeSwitch);
      operation = 'branch'; args = ['-d', '--', branch.name];
    } else if (body.action === 'branch-create' || body.action === 'branch-recover') {
      const name = stringValue(body.target, 'Branch name', 250);
      if (name.startsWith('-') || (await run(ctx, 'check-ref-format', ['--branch', name], { acceptedCodes: [128, 1] })).code !== 0) throw new AppError(400, 'INVALID_BRANCH', 'Enter a valid new branch name.');
      if (body.action === 'branch-recover') { operation = 'branch'; args = ['--', name, await resolveRef(ctx, body.message)]; }
      else { operation = 'switch'; args = ['-c', name, ...(body.message ? [await resolveRef(ctx, body.message)] : [])]; }
    } else if (body.action === 'rename') {
      const source = relativePath(body.path), target = relativePath(body.target);
      if (!state.some(e => e.path === source && e.index !== '?')) throw new AppError(400, 'INVALID_FILE', 'Choose a tracked changed file to move.');
      await validateFilePath(ctx.repo.root, source); await validateFilePath(ctx.repo.root, target);
      operation = 'mv'; args = ['--', source, target];
    } else if (body.action === 'discard') {
      const source = relativePath(body.path);
      if (!state.some(e => e.path === source && e.index !== '?' && !e.conflict && e.worktree !== ' ')) throw new AppError(400, 'INVALID_FILE', 'Choose a tracked unstaged file to restore from the index.');
      if (!body.discardFingerprint) throw new AppError(400, 'DISCARD_REVIEW_REQUIRED', 'Review and confirm this file before discarding its unstaged changes.');
      if ((await discardReview(ctx, source)).fingerprint !== body.discardFingerprint) throw new AppError(409, 'DISCARD_CHANGED', 'This file or its staged version changed after the discard review. Review the latest contents before discarding.');
      await validateFilePath(ctx.repo.root, source);
      operation = 'restore'; args = ['--worktree', '--', source];
    } else if (body.action.endsWith('-continue')) {
      operation = body.action.slice(0, -9); args = ['--continue'];
    } else if (body.action.endsWith('-abort')) {
      operation = body.action.slice(0, -6); args = ['--abort'];
    }
    // Never convert arbitrary form text into a shell command or a Git option.
    if (!operation) throw new AppError(400, 'INVALID_ACTION', 'Unsupported Git action.');
    const result = await git(ctx.repo.root, operation, args, { write: true, network });
    return { command: ['git', operation, ...args].map(redactGitOutput), output: redactGitOutput(result.output).trim() || 'Completed successfully.', ...(body.action === 'squash' ? { summary: 'Squash prepared. Review the staged changes, then commit to finish.' } : body.action === 'branch-recover' ? { summary: `Created recovery branch ${body.target}. Your current branch and working files are unchanged.` } : {}) };
  });
}
