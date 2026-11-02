import { git } from './git.js';
import { AppError } from './errors.js';
import { stringValue } from './paths.js';
import type { Context } from './repositories.js';

export interface UpstreamTarget { remote: string; branch: string }
const read = (ctx: Context, operation: string, args: string[], extra = {}) => git(ctx.repo.root, operation, args, { config: ctx.config, ...extra });

export async function configuredUpstream(ctx: Context, branch: string): Promise<UpstreamTarget | undefined> {
  if (!branch) return undefined;
  const [remote, merge] = await Promise.all([
    read(ctx, 'config', ['--get', `branch.${branch}.remote`], { acceptedCodes: [1] }),
    read(ctx, 'config', ['--get-all', `branch.${branch}.merge`], { acceptedCodes: [1] }),
  ]);
  const refs = merge.output.trim().split(/\r?\n/).filter(Boolean);
  if (refs.length > 1) throw new AppError(409, 'MULTIPLE_UPSTREAMS', 'This branch has multiple configured merge targets. Choose a single upstream in Git before using push or pull here.');
  if (!remote.output.trim() || !refs[0]?.startsWith('refs/heads/')) return undefined;
  return { remote: remote.output.trim(), branch: refs[0].slice('refs/heads/'.length) };
}

export async function networkTarget(ctx: Context, input: { remote?: unknown; remoteBranch?: unknown }, branch: string) {
  const remote = stringValue(input.remote, 'Remote', 200);
  const remotes = (await read(ctx, 'remote', [])).output.split(/\r?\n/).filter(Boolean);
  if (remote.startsWith('-') || !remotes.includes(remote)) throw new AppError(400, 'INVALID_REMOTE', 'Choose an existing configured remote.');
  const upstream = await configuredUpstream(ctx, branch);
  const remoteBranch = input.remoteBranch === undefined ? (upstream?.remote === remote ? upstream.branch : branch) : stringValue(input.remoteBranch, 'Remote branch', 250);
  if (remoteBranch && (remoteBranch.startsWith('-') || (await read(ctx, 'check-ref-format', [`refs/heads/${remoteBranch}`], { acceptedCodes: [1, 128] })).code !== 0)) throw new AppError(400, 'INVALID_BRANCH', 'Enter a valid remote branch name.');
  let trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
  if (branch && upstream?.remote === remote && upstream.branch === remoteBranch) {
    const configured = (await read(ctx, 'for-each-ref', ['--format=%(upstream)', `refs/heads/${branch}`])).output.trim();
    if (configured) trackingRef = configured;
  }
  return { remote, remoteBranch, trackingRef, upstream, setUpstream: !upstream };
}
