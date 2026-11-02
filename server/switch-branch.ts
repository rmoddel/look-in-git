import type { ActionResult, Branch, Stash } from '../shared/types.js';
import { branchRef } from '../shared/branches.js';
import type { Context } from './repositories.js';
import { actionOptions } from './actions.js';
import { git } from './git.js';
import { AppError } from './errors.js';
import { branches, resolveRef } from './service.js';
import { parseStatus } from './parsers.js';
import { redactGitOutput } from './diagnostics.js';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

// Called inside the repository write lock. Never pulls into the branch being left.
export async function switchBranch(ctx: Context, selected: Branch, stashBeforeSwitch: boolean): Promise<ActionResult> {
  const root = ctx.repo.root;
  const read = (operation: string, args: string[], extra = {}) => git(root, operation, args, { config: ctx.config, ...extra });
  const commands: string[][] = [], output: string[] = [];
  async function write(operation: string, args: string[], network = false) {
    commands.push(['git', operation, ...args]);
    const result = await git(root, operation, args, { write: true, network });
    if (result.output.trim()) output.push(result.output.trim());
  }
  const before = await actionOptions(ctx);
  if (before.mergeInProgress || before.rebaseInProgress || before.cherryPickInProgress || before.revertInProgress) throw new AppError(409, 'OPERATION_IN_PROGRESS', 'Complete or abort the current Git operation before switching branches.');
  let localName = selected.name, trackingRef = '', existing: Branch | undefined = selected.remote ? undefined : before.branches.find(branch => !branch.remote && branch.name === selected.name);
  async function occupiedElsewhere(branch: Branch | undefined, fetched = false) {
    if (!branch?.worktreePath) return;
    // Git uses forward slashes on Windows. Canonicalize case, separators and
    // junction aliases before deciding whether this is our current checkout.
    const canonical = async (value: string) => {
      const resolved = await realpath(value).catch(() => path.resolve(value));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (await canonical(branch.worktreePath) === await canonical(root)) return;
    throw new AppError(409, 'BRANCH_IN_WORKTREE', `Local branch ${branch.name} is already checked out in another worktree:\n${branch.worktreePath}\nOpen that existing worktree to work on this branch. ${fetched ? 'Remote commits were fetched, but nothing was stashed or switched.' : 'Nothing was fetched, stashed, or switched.'}`, { worktree: { path: branch.worktreePath, branch: branch.name } });
  }
  const startingHead = await read('rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] });
  let fetchedHead = '', ahead = 0;
  if (selected.remote) {
    const remote = [...before.remotes].sort((a, b) => b.length - a.length).find(name => selected.name.startsWith(name + '/'));
    if (!remote) throw new AppError(400, 'INVALID_BRANCH', 'This remote-tracking branch has no configured remote.');
    localName = selected.name.slice(remote.length + 1);
    trackingRef = branchRef(selected);
    existing = before.branches.find(branch => !branch.remote && branch.name === localName);
    await occupiedElsewhere(existing);
    if (existing) {
      const upstream = (await read('for-each-ref', ['--format=%(upstream)', branchRef(existing)])).output.trim();
      if (upstream && upstream !== trackingRef) throw new AppError(409, 'DIFFERENT_UPSTREAM', `Local branch ${localName} already tracks ${upstream.replace(/^refs\/remotes\//, '')}. Its upstream was not changed. Choose that local branch or change its upstream explicitly in Git.`);
    }
    // Explicit refspec updates only the selected remote-tracking branch. It does
    // not merge into HEAD, prune branches, or reset any local branch.
    await write('fetch', ['--no-tags', '--no-recurse-submodules', '--', remote, `+refs/heads/${localName}:${trackingRef}`], true);
    fetchedHead = await resolveRef(ctx, trackingRef);
    const nowBranch = (await read('symbolic-ref', ['--quiet', '--short', 'HEAD'], { acceptedCodes: [1] })).output.trim();
    const nowHead = await read('rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] });
    if (nowBranch !== before.branch || nowHead.output !== startingHead.output) throw new AppError(409, 'CHECKOUT_CHANGED', 'The checked-out branch changed while fetching. Nothing was stashed or switched. Try again from the current branch.');
    if (existing) {
      const localHead = await resolveRef(ctx, branchRef(existing));
      const counts = (await read('rev-list', ['--left-right', '--count', `${localHead}...${fetchedHead}`, '--'])).output.trim().split(/\s+/).map(Number);
      ahead = counts[0];
      if (ahead && counts[1]) throw new AppError(409, 'BRANCH_DIVERGED', `Local ${localName} and ${selected.name} have diverged. The latest remote commits were fetched, but no local files were stashed or switched. Merge or rebase that local branch explicitly, then try again.`);
    }
  } else {
    if (!existing) throw new AppError(409, 'BRANCH_CHANGED', 'The selected local branch changed. Nothing was stashed or switched. Refresh and choose the branch again.');
    await occupiedElsewhere(existing);
    if (before.branch === localName) throw new AppError(400, 'CURRENT_BRANCH', 'That branch is already checked out.');
  }

  // Another Git client can create a worktree while a network fetch is running.
  // Recheck before saving any local edits; the initial guard remains before fetch.
  await occupiedElsewhere((await branches(ctx)).find(branch => !branch.remote && branch.name === localName), selected.remote);

  let stashed: Stash | undefined;
  let switched = false;
  let switchCommand: string[] = [];
  try {
    const status = parseStatus((await read('status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all'])).output);
    if (status.some(entry => entry.conflict)) throw new AppError(409, 'UNRESOLVED_CONFLICTS', 'Resolve the current conflicts before switching branches.');
    if ((stashBeforeSwitch || selected.remote) && status.length) {
      const oldStash = (await actionOptions(ctx)).stashes[0]?.hash;
      await write('stash', ['push', '--include-untracked', '-m', `Look-in-Git: ${before.branch || 'detached HEAD'} → ${localName}`]);
      const newest = (await actionOptions(ctx)).stashes[0];
      if (newest && newest.hash !== oldStash) stashed = newest;
      if (!stashed) throw new AppError(409, 'STASH_NOT_CREATED', 'Git did not create the expected stash. The branch was not switched.');
    }
    const switchArgs = selected.remote && !existing ? ['--track', '-c', localName, '--', trackingRef] : ['--no-guess', '--', localName];
    switchCommand = ['git', 'switch', ...switchArgs];
    await write('switch', switchArgs);
    switched = true;
    if (selected.remote && existing) {
      await write('merge', ['--ff-only', '--no-autostash', '--no-edit', '--no-gpg-sign', fetchedHead]);
      await write('branch', [`--set-upstream-to=${trackingRef}`, '--', localName]);
    }
    const summary = selected.remote ? `Switched to local ${localName}, tracking ${selected.name}.${ahead ? ` Kept ${ahead} local-only ${ahead === 1 ? 'commit' : 'commits'}.` : ' Updated to the fetched remote tip.'}${stashed ? ' Your previous changes are stashed; choose whether to reapply them.' : ''}` : `Switched to ${localName}.${stashed ? ' Your previous changes are stashed; choose whether to reapply them.' : ''}`;
    return { command: switchCommand.map(redactGitOutput), commands: commands.map(command => command.map(redactGitOutput)), output: redactGitOutput(output.join('\n')), switchedBranch: localName, summary, ...(stashed ? { stashed } : {}) };
  } catch (error) {
    if (stashed) throw new AppError(422, 'SWITCH_STASH_SAVED', `${switched ? `Now on ${localName}, but its update did not finish.` : 'The branch switch did not finish.'} Your previous changes remain saved in ${stashed.ref} (${stashed.hash.slice(0, 8)}). Reapply the stash when ready.\n${(error as Error).message}`, { stashed });
    throw error;
  }
}
