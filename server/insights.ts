import type { Commit, CommitDetail, ReflogEntry, StashPreview } from '../shared/types.js';
import type { Context } from './repositories.js';
import { git } from './git.js';
import { AppError } from './errors.js';
import { stringValue, validateFilePath } from './paths.js';
import { comparison, resolveRef } from './service.js';
import { actionOptions } from './actions.js';

const PAGE_SIZE = 50;
const commitFormat = '%H%x00%P%x00%s%x00%an%x00%aI';
const historyFormat = `${commitFormat}%x00%D`;
const logFlags = ['-z', '--no-show-signature', '--no-notes', '--no-color', '--encoding=UTF-8'];
const run = (ctx: Context, op: string, args: string[], extra = {}) => git(ctx.repo.root, op, args, { config: ctx.config, ...extra });

function pageOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999999) return value;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) throw new AppError(400, 'INVALID_OFFSET', 'Invalid history offset.');
  return Number(value);
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === '') return '';
  const text = stringValue(value, label, max);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new AppError(400, 'INVALID_INPUT', `${label} must be a single line.`);
  return text;
}

function parseCommits(output: string, includeRefs = false): Commit[] {
  const fields = output.split('\0');
  const commits: Commit[] = [];
  const stride = includeRefs ? 6 : 5;
  for (let i = 0; i + stride - 1 < fields.length; i += stride) {
    commits.push({ hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), subject: fields[i + 2], author: fields[i + 3], date: fields[i + 4], ...(includeRefs ? { refs: fields[i + 5].split(', ').filter(Boolean) } : {}) });
  }
  return commits;
}

/** Git performs the full-history search; only the requested result page is read. */
export async function historySearch(ctx: Context, input: { offset?: unknown; ref?: unknown; q?: unknown; author?: unknown; path?: unknown }): Promise<{ commits: Commit[]; hasMore: boolean }> {
  const offset = pageOffset(input.offset);
  const q = optionalText(input.q, 'Search', 500);
  const author = optionalText(input.author, 'Author', 200);
  const file = input.path === undefined || input.path === '' ? '' : stringValue(input.path, 'File path');
  if (file) await validateFilePath(ctx.repo.root, file);
  const ref = input.ref === undefined || input.ref === '' ? 'HEAD' : stringValue(input.ref, 'Revision', 250);
  let revisions: string[];
  if (ref === 'all') revisions = ['--branches', '--remotes', '--tags'];
  else {
    if (ref === 'HEAD') {
      const head = await run(ctx, 'rev-parse', ['--verify', '--end-of-options', 'HEAD^{commit}'], { acceptedCodes: [128, 1] });
      if (head.code !== 0) return { commits: [], hasMore: false };
      revisions = [head.output.trim()];
    } else revisions = [await resolveRef(ctx, ref)];
  }

  // A resolvable hexadecimal ID is a direct lookup, restricted to the chosen
  // history scope. All other text is passed as a literal message/body pattern.
  let exactHash: string | null = null;
  if (/^[a-fA-F0-9]{4,64}$/.test(q)) {
    try { exactHash = await resolveRef(ctx, q); }
    catch (error) { if (!(error instanceof AppError) || error.code !== 'INVALID_REF') throw error; }
    if (exactHash) {
      const unreachable = await run(ctx, 'rev-list', ['--max-count=1', exactHash, '--not', ...revisions, '--']);
      if (unreachable.output.trim() || offset) return { commits: [], hasMore: false };
    }
  }
  const result = await run(ctx, 'log', [
    ...logFlags, `--format=${historyFormat}`, '--fixed-strings', '--regexp-ignore-case',
    `--max-count=${exactHash ? 1 : PAGE_SIZE + 1}`, `--skip=${offset}`,
    ...(author ? [`--author=${author}`] : []),
    ...(q && !exactHash ? [`--grep=${q}`] : []),
    ...(file && ref !== 'all' && !exactHash ? ['--follow'] : []),
    ...(exactHash ? ['--no-walk', exactHash] : revisions), '--', ...(file ? [file] : []),
  ]);
  const commits = parseCommits(result.output, true);
  return { commits: commits.slice(0, PAGE_SIZE), hasMore: commits.length > PAGE_SIZE };
}

export async function commitDetails(ctx: Context, value: unknown): Promise<CommitDetail> {
  const hash = await resolveRef(ctx, value);
  const result = await run(ctx, 'log', [
    ...logFlags, '--decorate=short', '--max-count=1',
    `--format=${commitFormat}%x00%b%x00%ae%x00%cn%x00%ce%x00%cI%x00%D`, hash, '--',
  ]);
  const fields = result.output.split('\0');
  return {
    ...parseCommits(fields.slice(0, 5).join('\0') + '\0')[0],
    body: fields[5].replace(/\n$/, ''), email: fields[6], committer: fields[7],
    committerEmail: fields[8], committedDate: fields[9], decorations: fields[10],
  };
}

export async function reflogEntries(ctx: Context, value?: unknown): Promise<{ entries: ReflogEntry[]; hasMore: boolean }> {
  const offset = pageOffset(value);
  const head = await run(ctx, 'rev-parse', ['--verify', '--end-of-options', 'HEAD^{commit}'], { acceptedCodes: [128, 1] });
  if (head.code !== 0) return { entries: [], hasMore: false };
  const result = await run(ctx, 'log', [
    ...logFlags, '-g', '--date=iso-strict', '--format=%H%x00%gD%x00%gs%x00%gn',
    `--max-count=${PAGE_SIZE + 1}`, `--skip=${offset}`, 'HEAD', '--',
  ]);
  const fields = result.output.split('\0');
  const entries: ReflogEntry[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    // %gD with an explicit date format carries the reflog event timestamp.
    // %aI/%cI describe the referenced commit and can be years older instead.
    const date = fields[i + 1].match(/@\{(.+)\}$/)?.[1] ?? '';
    entries.push({ hash: fields[i], selector: `HEAD@{${offset + entries.length}}`, subject: fields[i + 2], date, author: fields[i + 3] });
  }
  return { entries: entries.slice(0, PAGE_SIZE), hasMore: entries.length > PAGE_SIZE };
}

export async function stashPreview(ctx: Context, value: unknown): Promise<StashPreview> {
  const hash = stringValue(value, 'Stash hash', 64);
  if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new AppError(400, 'INVALID_STASH', 'Select an existing stash by its full commit ID.');
  const stash = (await actionOptions(ctx)).stashes.find(entry => entry.hash === hash);
  if (!stash) throw new AppError(404, 'STASH_NOT_FOUND', 'This stash is no longer available. Refresh the stash list.');
  const details = await commitDetails(ctx, hash);
  if (details.parents.length < 2 || details.parents.length > 3) throw new AppError(422, 'INVALID_STASH', 'This stash has an unsupported parent structure.');
  const [staged, unstaged, untracked] = await Promise.all([
    comparison(ctx, 'compare', details.parents[0], details.parents[1]),
    comparison(ctx, 'compare', details.parents[1], hash),
    details.parents[2] ? comparison(ctx, 'commit', undefined, details.parents[2]) : null,
  ]);
  if (untracked?.from) throw new AppError(422, 'INVALID_STASH', 'This stash has an unsupported untracked-file tree.');
  return { stash, staged, unstaged, untracked };
}
