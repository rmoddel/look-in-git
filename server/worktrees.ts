import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { WorktreeActionInput, WorktreeInfo } from '../shared/worktrees.js';
import { AppError } from './errors.js';
import { git } from './git.js';
import { parseStatus } from './parsers.js';
import { directory, stringValue } from './paths.js';
import type { Context } from './repositories.js';
import { withWriteLock } from './actions.js';
import { resolveRef } from './service.js';
import { localDirectory, folderName } from './repository-tools.js';

const read = (ctx: Context, operation: string, args: string[], cwd = ctx.repo.root) => git(cwd, operation, args, { config: ctx.config, acceptedCodes: [1] });
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Parse `git worktree list --porcelain -z`: fields and record boundaries are NUL-delimited. */
export function parseWorktreePorcelain(raw: string) {
  const records: string[][] = [];
  let fields: string[] = [];
  for (const field of raw.split('\0')) {
    if (!field) { if (fields.length) records.push(fields); fields = []; }
    else fields.push(field);
  }
  if (fields.length) records.push(fields);
  return records.filter(fields => fields.some(field => field.startsWith('worktree '))).map(fields => {
    const value = (key: string) => fields.find(field => field.startsWith(`${key} `))?.slice(key.length + 1) ?? '';
    const locked = fields.find(field => field === 'locked' || field.startsWith('locked '));
    const prunable = fields.find(field => field === 'prunable' || field.startsWith('prunable '));
    return { path: value('worktree'), head: value('HEAD'), branchRef: value('branch'), detached: fields.includes('detached'), locked: locked !== undefined, lockReason: locked?.includes(' ') ? locked.slice(locked.indexOf(' ') + 1) : '', prunable: prunable !== undefined, prunableReason: prunable?.includes(' ') ? prunable.slice(prunable.indexOf(' ') + 1) : '' };
  });
}

export async function worktrees(ctx: Context): Promise<WorktreeInfo[]> {
  const raw = (await read(ctx, 'worktree', ['list', '--porcelain', '-z'])).output;
  const records = parseWorktreePorcelain(raw);
  const common = await realpath((await git(ctx.repo.root, 'rev-parse', ['--path-format=absolute', '--git-common-dir'], { config: ctx.config })).output.trim());
  const rows = await Promise.all(records.map(async item => {
    const branch = item.branchRef.replace(/^refs\/heads\//, '');
    const name = path.basename(item.path.replace(/[\\/]$/, '')) || item.path;
    let dirty = false, staged = 0, unstaged = 0, untracked = 0, main = false;
    try {
      const canonical = await directory(item.path);
      const [gitDirResult, status] = await Promise.all([
        git(canonical, 'rev-parse', ['--absolute-git-dir'], { config: ctx.config }),
        git(canonical, 'status', ['--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], { config: ctx.config }),
      ]);
      const gitDir = await realpath(gitDirResult.output.trim());
      const rootCommon = await realpath((await git(canonical, 'rev-parse', ['--path-format=absolute', '--git-common-dir'], { config: ctx.config })).output.trim());
      if (!samePath(rootCommon, common)) throw new AppError(409, 'WORKTREE_CHANGED', 'A listed worktree no longer belongs to this repository. Refresh the worktree list.');
      main = samePath(gitDir, common);
      const entries = parseStatus(status.output);
      staged = entries.filter(entry => entry.index !== ' ' && entry.index !== '?').length;
      unstaged = entries.filter(entry => entry.worktree !== ' ').length;
      untracked = entries.filter(entry => entry.index === '?').length;
      dirty = entries.length > 0;
    } catch (error) {
      if (!item.prunable) throw error;
    }
    return { path: path.resolve(item.path), name, head: item.head, branch, dirty, staged, unstaged, untracked, detached: item.detached || !branch, locked: item.locked, lockReason: item.lockReason, prunable: item.prunable, prunableReason: item.prunableReason, main };
  }));
  return rows;
}

function object(value: unknown): WorktreeActionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_INPUT', 'Provide worktree operation details.');
  const input = value as WorktreeActionInput;
  const fields: Record<string, string[]> = {
    create: ['path', 'branch', 'newBranch', 'base'], move: ['path', 'target'], lock: ['path'], unlock: ['path'], remove: ['path', 'confirm', 'deleteBranch'], repair: ['path', 'confirm'], prune: ['confirm'],
  };
  if (!fields[input.action] || Object.keys(input).some(key => !['action', ...fields[input.action]].includes(key))) throw new AppError(400, 'INVALID_INPUT', 'Unknown worktree action or parameter.');
  if ((input.confirm !== undefined && typeof input.confirm !== 'boolean') || (input.deleteBranch !== undefined && typeof input.deleteBranch !== 'boolean')) throw new AppError(400, 'INVALID_INPUT', 'Confirmation and branch deletion options must be true or false.');
  return input;
}

async function locate(ctx: Context, value: unknown) {
  const supplied = stringValue(value, 'Worktree path');
  if (!path.isAbsolute(supplied) || supplied.startsWith('\\\\') || supplied.startsWith('//')) throw new AppError(400, 'INVALID_WORKTREE_PATH', 'Choose a listed worktree on a local disk.');
  const listed = await worktrees(ctx), item = listed.find(tree => samePath(tree.path, supplied));
  if (!item) throw new AppError(400, 'INVALID_WORKTREE_PATH', 'Choose a worktree from this repository’s current worktree list.');
  if (item.prunable) throw new AppError(409, 'WORKTREE_MISSING', 'This worktree folder is missing. Repair or prune its stale metadata.');
  const root = await directory(item.path);
  const common = await realpath((await git(root, 'rev-parse', ['--path-format=absolute', '--git-common-dir'], { config: ctx.config })).output.trim());
  const expected = await realpath((await git(ctx.repo.root, 'rev-parse', ['--path-format=absolute', '--git-common-dir'], { config: ctx.config })).output.trim());
  if (!samePath(common, expected)) throw new AppError(409, 'WORKTREE_CHANGED', 'This folder is no longer linked to the selected repository. Refresh and try again.');
  return { item, root };
}

async function safeDestination(value: unknown) {
  const supplied = stringValue(value, 'New worktree path');
  if (!path.isAbsolute(supplied) || supplied.startsWith('\\\\') || supplied.startsWith('//') || supplied.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new AppError(400, 'INVALID_WORKTREE_PATH', 'Choose an absolute local folder path without traversal components.');
  const parent = await localDirectory(path.dirname(path.resolve(supplied)));
  const target = path.join(parent, folderName(path.basename(path.resolve(supplied))));
  try { await lstat(target); throw new AppError(409, 'DESTINATION_EXISTS', 'The destination folder already exists. Choose an unused folder.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}

async function ensureDisjoint(ctx: Context, target: string) {
  for (const tree of await worktrees(ctx)) {
    const existing = path.resolve(tree.path);
    const targetFromTree = path.relative(existing, target);
    const treeFromTarget = path.relative(target, existing);
    const inside = (relative: string) => relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    if (inside(targetFromTree) || inside(treeFromTarget)) throw new AppError(400, 'OVERLAPPING_WORKTREE_PATH', 'Choose a folder that does not contain or sit inside an existing worktree. Worktrees need separate sibling folders.');
  }
}

export async function manageWorktree(ctx: Context, value: unknown) {
  const input = object(value);
  return withWriteLock(ctx.lockKey, async () => {
    const run = (args: string[]) => git(ctx.repo.root, 'worktree', args, { write: true, config: ctx.config });
    let summary = '';
    if (input.action === 'create') {
      const hasBranch = typeof input.branch === 'string', hasNewBranch = typeof input.newBranch === 'string';
      if (hasBranch === hasNewBranch) throw new AppError(400, 'INVALID_INPUT', 'Choose either an existing branch or a new branch.');
      const target = await safeDestination(input.path);
      await ensureDisjoint(ctx, target);
      const base = await resolveRef(ctx, input.base ?? (hasBranch ? input.branch : 'HEAD'));
      const args = hasNewBranch
        ? ['add', '-b', await branchName(ctx, input.newBranch), '--', target, base]
        : ['add', '--', target, await branchName(ctx, input.branch)];
      await run(args); summary = `Created worktree at ${target}. Its files and staging area are independent.`;
    } else if (input.action === 'move') {
      const { item, root } = await locate(ctx, input.path);
      if (item.main) throw new AppError(409, 'MAIN_WORKTREE', 'The main worktree cannot be moved from Look-in-Git.');
      if (item.dirty) throw new AppError(409, 'DIRTY_WORKTREE', 'Commit or stash this worktree’s changes before moving it. No files were changed.');
      const target = await safeDestination(input.target);
      await ensureDisjoint(ctx, target);
      try { await run(['move', root, target]); }
      catch { throw new AppError(422, 'WORKTREE_MOVE_FAILED', `Git could not move this worktree to ${target}. Its original folder and branch remain in place; check folder permissions and refresh.`); }
      summary = `Moved the worktree to ${target}.`;
    } else if (input.action === 'lock' || input.action === 'unlock') {
      const { root } = await locate(ctx, input.path);
      await run([input.action, '--', root]); summary = input.action === 'lock' ? 'Locked this worktree so Git will not prune or move it accidentally.' : 'Unlocked this worktree.';
    } else if (input.action === 'remove') {
      const { item, root } = await locate(ctx, input.path);
      if (item.main) throw new AppError(409, 'MAIN_WORKTREE', 'The main worktree cannot be removed.');
      if (input.confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Confirm that you want to remove this worktree.');
      if (item.dirty) throw new AppError(409, 'DIRTY_WORKTREE', 'This worktree has uncommitted changes. Commit or stash them first. Look-in-Git will not force-remove or discard them.');
      const branch = item.branch;
      if (input.deleteBranch === true && branch) {
        const merged = await git(ctx.repo.root, 'branch', ['--merged', 'HEAD', '--list', branch], { write: true, config: ctx.config });
        if (!merged.output.split(/\r?\n/).some(line => line.replace(/^[*+]\s+/, '').trim() === branch)) throw new AppError(409, 'BRANCH_NOT_MERGED', `The worktree is clean, but branch ${branch} is not merged into the current branch. It will be kept; merge it explicitly before deleting it.`);
      }
      await run(['remove', '--', root]);
      if (input.deleteBranch === true && branch) {
        const stillCheckedOut = (await worktrees(ctx)).some(tree => tree.branch === branch);
        if (stillCheckedOut) throw new AppError(409, 'BRANCH_IN_USE', 'The worktree was removed, but its branch is checked out elsewhere and was kept.');
        await git(ctx.repo.root, 'branch', ['--delete', '--', branch], { write: true, config: ctx.config });
        summary = `Removed the worktree and deleted the merged branch ${branch}.`;
      } else summary = `Removed the clean worktree. ${branch ? `Branch ${branch} was kept.` : 'No branch was deleted.'}`;
    } else if (input.action === 'repair') {
      if (input.confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Confirm that you want to repair Git worktree links.');
      const target = input.path === undefined ? undefined : await localDirectory(input.path);
      await run(['repair', ...(target ? [target] : [])]); summary = 'Repaired Git worktree links for the selected location.';
    } else if (input.action === 'prune') {
      if (input.confirm !== true) throw new AppError(400, 'CONFIRM_REQUIRED', 'Confirm that you want to prune stale Git worktree metadata.');
      await run(['prune', '--expire=now']); summary = 'Pruned stale worktree metadata. Existing worktree folders were not deleted.';
    }
    return { action: input.action, summary, worktrees: await worktrees(ctx) };
  });
}

async function branchName(ctx: Context, value: unknown) {
  const name = stringValue(value, 'Branch name', 250);
  if (name.startsWith('-') || name.startsWith('refs/') || name === 'HEAD' || (await git(ctx.repo.root, 'check-ref-format', [`refs/heads/${name}`], { config: ctx.config, acceptedCodes: [1, 128] })).code !== 0) throw new AppError(400, 'INVALID_BRANCH', 'Choose a valid local branch name.');
  return name;
}
