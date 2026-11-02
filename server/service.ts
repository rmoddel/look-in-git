import { createHash } from 'node:crypto';
import { canSelectLines } from './line-patch.js';
import type { ChangedFile, Commit, Branch, Comparison, DiffResult, Scope, WorkingCopy, FileStatus } from '../shared/types.js';
import { git } from './git.js';
import type { Context } from './repositories.js';
import { applyStats, parseNameStatus, parseNumstat, parseStatus } from './parsers.js';
import { FILE_LIMIT, readUntracked, stringValue, validateFilePath } from './paths.js';
import { AppError } from './errors.js';

const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=all'];
function run(context: Context, operation: string, args: string[], extra = {}) {
  return git(context.repo.root, operation, args, { config: context.config, ...extra });
}
export async function resolveRef(context: Context, value: unknown): Promise<string> {
  const ref = stringValue(value, 'Revision', 250);
  if (ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new AppError(400, 'INVALID_REF', 'Enter a commit ID or a valid local branch/tag expression.');
  const result = await run(context, 'rev-parse', ['--verify', '--end-of-options', `${ref}^{commit}`], { acceptedCodes: [128, 1] });
  const hash = result.output.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(hash)) throw new AppError(400, 'INVALID_REF', `Cannot resolve revision: ${ref}`);
  return hash;
}

async function untrackedInfo(context: Context, file: ChangedFile) {
  try {
    const { data, large } = await readUntracked(context.repo.root, file.path);
    const binary = data.includes(0);
    return { ...file, binary, added: large || binary ? null : countLines(data.toString('utf8')), deleted: binary ? null : 0, ...(large ? { note: 'Large file — preview is limited to 1 MiB; line total is unknown.' } : {}) };
  } catch (error) { return { ...file, added: null, deleted: null, note: error instanceof Error ? error.message : 'File is unavailable.' }; }
}
function countLines(value: string) { return value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0; }

export async function working(context: Context): Promise<WorkingCopy> {
  const [status, staged, unstaged, branch, headResult, upstreamResult] = await Promise.all([
    run(context, 'status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all']),
    run(context, 'diff', [...diffFlags, '--cached', '--numstat', '-z', '--']),
    run(context, 'diff', [...diffFlags, '--numstat', '-z', '--']),
    run(context, 'symbolic-ref', ['--quiet', '--short', 'HEAD'], { acceptedCodes: [1] }),
    run(context, 'rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] }),
    run(context, 'rev-parse', ['--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { acceptedCodes: [128, 1] }),
  ]);
  let files: ChangedFile[] = [];
  for (const entry of parseStatus(status.output)) {
    const base = { path: entry.path, oldPath: entry.oldPath, added: 0, deleted: 0, binary: false };
    if (entry.index === '?') files.push({ ...base, scope: 'untracked', status: '?' });
    else if (entry.conflict) files.push({ ...base, scope: 'unstaged', status: 'U', conflict: true });
    else {
      if (entry.index !== ' ') files.push({ ...base, scope: 'staged', status: entry.index as FileStatus });
      if (entry.worktree !== ' ') files.push({ ...base, scope: 'unstaged', status: entry.worktree as FileStatus });
    }
  }
  const stagedStats = parseNumstat(staged.output), unstagedStats = parseNumstat(unstaged.output);
  const stagedMap = new Map(stagedStats.map(stat => [stat.path, stat]));
  const unstagedMap = new Map(unstagedStats.map(stat => [stat.path, stat]));
  files = files.map(file => {
    const stat = (file.scope === 'staged' ? stagedMap : unstagedMap).get(file.path);
    return stat ? { ...file, added: stat.added, deleted: stat.deleted, binary: stat.binary } : file;
  });
  // Bound file reads even in a repository with thousands of untracked files.
  let count = 0;
  const enriched: ChangedFile[] = [];
  for (const file of files) enriched.push(file.scope === 'untracked' ? (++count <= 150 ? await untrackedInfo(context, file) : { ...file, added: null, deleted: null, note: 'Select this file to load its preview.' }) : file);
  const upstream = upstreamResult.code === 0 ? upstreamResult.output.trim() : null;
  let ahead = 0, behind = 0;
  if (upstream && headResult.code === 0) {
    const counts = await run(context, 'rev-list', ['--left-right', '--count', 'HEAD...@{upstream}', '--']);
    [ahead, behind] = counts.output.trim().split(/\s+/).map(Number);
  }
  return { files: enriched, branch: branch.output.trim() || (headResult.code === 0 ? `Detached · ${headResult.output.trim().slice(0, 7)}` : 'No commits yet'), head: headResult.code === 0 ? headResult.output.trim() : null, upstream, ahead, behind, refreshedAt: new Date().toISOString() };
}

export async function history(context: Context, offset: number): Promise<{ commits: Commit[]; hasMore: boolean }> {
  const head = await run(context, 'rev-parse', ['--verify', 'HEAD'], { acceptedCodes: [128, 1] });
  if (head.code !== 0) return { commits: [], hasMore: false };
  const result = await run(context, 'log', ['-z', '--no-show-signature', '--no-decorate', '--format=%H%x00%P%x00%s%x00%an%x00%aI', '--max-count=51', `--skip=${offset}`, 'HEAD', '--']);
  const fields = result.output.split('\0');
  const commits: Commit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    commits.push({ hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), subject: fields[i + 2], author: fields[i + 3], date: fields[i + 4] });
  }
  return { commits: commits.slice(0, 50), hasMore: commits.length > 50 };
}

export async function branches(context: Context): Promise<Branch[]> {
  const result = await run(context, 'for-each-ref', ['--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(subject)%00%(committerdate:iso-strict)%00%(worktreepath)%00', 'refs/heads/', 'refs/remotes/']);
  const fields = result.output.split('\0');
  const resultBranches: Branch[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const ref = fields[i].replace(/^\r?\n/, '');
    if (!ref || ref.endsWith('/HEAD')) continue;
    resultBranches.push({ name: ref.replace(/^refs\/(heads|remotes)\//, ''), hash: fields[i + 1], current: fields[i + 2] === '*', remote: ref.startsWith('refs/remotes/'), subject: fields[i + 3], date: fields[i + 4], ...(fields[i + 5] ? { worktreePath: fields[i + 5] } : {}) });
  }
  return resultBranches;
}

export async function revisions(context: Context, scope: Scope, from: unknown, to: unknown): Promise<{ hashes: string[]; from: string | null; to: string }> {
  const target = await resolveRef(context, to);
  if (scope === 'compare') {
    const source = await resolveRef(context, from);
    return { hashes: [source, target], from: source, to: target };
  }
  const parents = await run(context, 'log', ['-1', '--no-show-signature', '--format=%P', target, '--']);
  const parent = parents.output.trim().split(' ')[0] || null;
  return { hashes: parent ? [parent, target] : [target], from: parent, to: target };
}

export async function comparison(context: Context, scope: 'commit' | 'compare', from: unknown, to: unknown): Promise<Comparison> {
  const refs = await revisions(context, scope, from, to);
  const operation = refs.from ? 'diff' : 'diff-tree';
  const prefix = refs.from ? [] : ['--root', '--no-commit-id', '-r'];
  const [names, stats] = await Promise.all([
    run(context, operation, [...prefix, ...diffFlags, '--name-status', '-z', ...refs.hashes, '--']),
    run(context, operation, [...prefix, ...diffFlags, '--numstat', '-z', ...refs.hashes, '--']),
  ]);
  return { files: applyStats(parseNameStatus(names.output, scope), parseNumstat(stats.output)), from: refs.from, to: refs.to };
}

export async function diff(context: Context, scope: Scope, name: string, from?: unknown, to?: unknown, contextLines: unknown = 3): Promise<DiffResult> {
  if(!['3','10','25','50'].includes(String(contextLines)))throw new AppError(400,'INVALID_CONTEXT','Choose 3, 10, 25, or 50 context lines.');
  await validateFilePath(context.repo.root, name);
  let files: ChangedFile[];
  let args: string[];
  let operation = 'diff';
  if (scope === 'commit' || scope === 'compare') {
    const result = await comparison(context, scope, from, to);
    files = result.files;
    operation = result.from ? 'diff' : 'diff-tree';
    args = result.from ? [result.from, result.to] : ['--root', '--no-commit-id', '-r', result.to];
  } else {
    // Re-read status: a client cannot turn this endpoint into an arbitrary file reader.
    const status = parseStatus((await run(context, 'status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all'])).output);
    const entry = status.find(e => e.path === name);
    const valid = entry && (scope === 'untracked' ? entry.index === '?' : scope === 'staged' ? ![' ', '?', '!'].includes(entry.index) && !entry.conflict : entry.conflict || ![' ', '?', '!'].includes(entry.worktree));
    if (!valid) throw new AppError(404, 'FILE_NOT_CHANGED', 'This file is no longer changed in this section. Refresh the working copy.');
    files = [{ path: entry.path, oldPath: entry.oldPath, status: entry.conflict ? 'U' : 'M', scope, added: 0, deleted: 0, binary: false }];
    args = scope === 'staged' ? ['--cached'] : [];
  }
  const file = files.find(f => f.path === name);
  if (!file) throw new AppError(404, 'FILE_NOT_CHANGED', 'This file is not part of the selected comparison.');
  if (file.oldPath) await validateFilePath(context.repo.root, file.oldPath);
  if (scope === 'untracked') {
    const { data, large } = await readUntracked(context.repo.root, name);
    if (data.includes(0)) return { patch: '', binary: true, truncated: false, message: 'Binary file. A text preview is not available.' };
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    if (!text) return { patch: '', binary: false, truncated: false, message: 'This is an empty untracked file.' };
    const shown = lines.slice(0, 12000);
    const patch = `--- /dev/null\n+++ ${JSON.stringify('b/' + name)}\n@@ -0,0 +1,${shown.length} @@\n${shown.map(line => '+' + line).join('\n')}\n${!text.endsWith('\n') && !large ? '\\ No newline at end of file\n' : ''}`;
    return { patch, binary: false, truncated: large || lines.length > 12000, fingerprint: createHash('sha256').update(patch).digest('hex'), lineActions: !large && lines.length <= 12000 && canSelectLines(patch) };
  }
  if (file.status === 'U') return { patch: '', binary: false, truncated: false, message: 'This file has unresolved merge conflicts. Select it in Working Changes to open the embedded merge editor.' };
  const result = await run(context, operation, [...diffFlags, '--patch', `--unified=${contextLines}`, ...args, '--', name, ...(file.oldPath && file.oldPath !== name ? [file.oldPath] : [])], { limit: FILE_LIMIT, allowTruncate: true });
  const lines = result.output.split('\n');
  const binary = /^Binary files .* differ$/m.test(result.output) || /^GIT binary patch$/m.test(result.output);
  return { fingerprint: createHash('sha256').update(result.output).digest('hex'), lineActions: ['staged', 'unstaged'].includes(scope) && !binary && !result.truncated && lines.length <= 12000 && canSelectLines(result.output), patch: binary ? '' : lines.slice(0, 12000).join('\n'), binary, truncated: result.truncated || lines.length > 12000, ...(binary ? { message: 'Binary file changed. A text diff is not available.' } : !result.output ? { message: 'No text changes. This may be a rename, a mode change, or a file that changed since the last refresh.' } : {}) };
}
