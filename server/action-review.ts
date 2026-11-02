import { branchLabel } from '../shared/branches.js';
import { createHash } from 'node:crypto';
import type { ActionReview } from '../shared/types.js';
import { actionOptions } from './actions.js';
import { git } from './git.js';
import { AppError } from './errors.js';
import { stringValue } from './paths.js';
import { parseStatus } from './parsers.js';
import { resolveRef } from './service.js';
import type { Context } from './repositories.js';
import { networkTarget } from './network-target.js';
import { redactRemoteUrl } from './diagnostics.js';

// Display destinations without exposing credentials embedded in a remote URL.
export async function reviewAction(ctx: Context, input: { action?: unknown; target?: unknown; remote?: unknown; remoteBranch?: unknown }): Promise<ActionReview> {
  if (!['merge', 'squash', 'push', 'pull'].includes(String(input.action))) throw new AppError(400, 'INVALID_ACTION', 'Choose merge, squash merge, push, or pull to review.');
  const action = input.action as ActionReview['action'];
  const run = (op: string, args: string[], extra = {}) => git(ctx.repo.root, op, args, { config: ctx.config, ...extra });
  const [options, headResult, statusResult] = await Promise.all([
    actionOptions(ctx), run('rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] }),
    run('status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all']),
  ]);
  const branch = options.branch, head = headResult.code === 0 ? headResult.output.trim() : null;
  const network = action === 'push' || action === 'pull';
  const state = parseStatus(statusResult.output);
  const details: string[] = [], warnings: string[] = [];
  let blocked: string | null = null, targetHash: string | null = null, rawUrls: string[] = [];
  let target = '', remote = '', remoteBranch = '', setUpstream = false;
  if (!branch) blocked = 'Switch to a local branch before running this action. HEAD is detached.';
  else if (!head) blocked = 'Create the first commit on this branch before running this action.';
  else if (options.mergeInProgress || options.rebaseInProgress || options.cherryPickInProgress || options.revertInProgress || state.some(file => file.conflict)) blocked = 'Finish or abort the current Git operation and resolve conflicts first.';

  if (network) {
    const destination = await networkTarget(ctx, input, branch);
    ({ remote, remoteBranch, setUpstream } = destination);
    const urls = await run('remote', ['get-url', ...(action === 'push' ? ['--push', '--all'] : []), '--', remote]);
    rawUrls = urls.output.trim().split(/\r?\n/).filter(Boolean);
    target = `${remote}/${remoteBranch}`;
    if (remoteBranch) {
      const resolved = await run('rev-parse', ['--verify', '--end-of-options', `${destination.trackingRef}^{commit}`], { acceptedCodes: [128, 1] });
      targetHash = resolved.code === 0 ? resolved.output.trim() : null;
    }
    const upstream = destination.upstream ? `${destination.upstream.remote}/${destination.upstream.branch}` : '';
    if (upstream && upstream !== target) warnings.push(`Current upstream is ${upstream}. This action uses ${target} and preserves the existing upstream setting.`);
  } else {
    target = stringValue(input.target, 'Source branch or commit', 250);
    targetHash = await resolveRef(ctx, target);
    target = branchLabel(target);
  }
  let outgoing: number | null = null, incoming: number | null = null;
  if (head && targetHash) {
    const counts = await run('rev-list', ['--left-right', '--count', `${head}...${targetHash}`, '--']);
    [outgoing, incoming] = counts.output.trim().split(/\s+/).map(Number);
  }
  let effect: string, submitLabel: string;
  if (action === 'push') {
    effect = `Publish committed work from ${branch} to ${target}.`;
    submitLabel = `Push to ${target}`;
    details.push('Only commits are sent. Staged, unstaged, and untracked files stay on this computer.', setUpstream ? 'Creates the remote branch if needed and sets it as this local branch’s upstream because none is configured.' : 'Creates the remote branch if needed and preserves this local branch’s existing upstream.', 'Uses a normal push. Git refuses to overwrite a diverged remote branch.');
    if (incoming && outgoing) warnings.push('The last fetched refs show divergence. Fetch and integrate the remote commits before pushing.');
    else if (incoming) warnings.push('The last fetched refs show remote commits missing locally. A normal push may be rejected.');
  } else if (action === 'pull') {
    effect = `Download from ${target} and update local ${branch}.`;
    submitLabel = `Pull into ${branch}`;
    details.push('Updates files on disk and advances the current branch only when a fast-forward is possible.', 'If the branches have diverged, Git stops. Choose merge or rebase separately.', 'Does not publish your commits, create a merge commit, or rebase your work.');
    if (incoming && outgoing) warnings.push('The last fetched refs show divergence. Fast-forward pull is expected to stop without integrating commits.');
  } else if (action === 'merge') {
    effect = `Bring ${target} into your current branch, ${branch || 'no local branch'}.`;
    submitLabel = `Merge into ${branch || 'current branch'}`;
    details.push('Keeps the source commits in history. Fast-forwards when possible; otherwise creates a merge commit automatically.', 'Changes the current branch and its files. The source branch stays in place; nothing is pushed.', 'Conflicts pause the merge. Resolve and stage the files, then commit, or choose Abort merge.');
    if (incoming === 0) warnings.push('The source is already included in the current branch. There is nothing new to merge.');
  } else {
    effect = `Combine the changes from ${target} in the staging area of ${branch || 'your current branch'}.`;
    submitLabel = `Stage squash into ${branch || 'current branch'}`;
    details.push('Stops before committing. Review the staged changes and write one commit message to finish.', 'Leaves the source branch and existing commits unchanged. This does not rewrite or squash your current branch’s history.', 'The final commit has one parent; Git will not record the source branch as merged. Nothing is pushed.', 'If conflicts occur, resolve and stage them before committing. There is no normal merge to abort; review file changes before discarding them.');
    if (state.length) blocked = 'Commit or stash your local changes first so the squash contains only the selected branch’s changes.';
    if (incoming === 0 && !blocked) blocked = 'The source is already included in the current branch. There is nothing to squash.';
  }
  if (state.length && action !== 'squash') warnings.push(action === 'push' ? `${state.length} changed ${state.length === 1 ? 'file is' : 'files are'} excluded from this push. Commit them first if you want to publish those edits.` : `${state.length} local ${state.length === 1 ? 'file has' : 'files have'} changes. Commit or stash them first if they overlap; Git may refuse this action.`);
  const fingerprint = createHash('sha256').update(JSON.stringify([ctx.repo.id, action, branch, head, target, targetHash, remote, remoteBranch, options.upstream, rawUrls, statusResult.output, blocked])).digest('hex');
  return { action, fingerprint, branch, head, source: action === 'push' ? branch : target, destination: action === 'push' ? target : branch, sourceKind: action === 'push' ? 'Local branch · committed work' : network ? 'Remote branch · download from' : 'Source branch or commit', destinationKind: action === 'push' ? 'Remote branch · publish to' : action === 'squash' ? 'Current local branch · stage here' : 'Current local branch · update here', effect, details, warnings, blocked, submitLabel, remoteUrls: rawUrls.map(redactRemoteUrl), incoming, outgoing, countsAreCached: network, ...(network ? { remoteBranch } : {}) };
}
