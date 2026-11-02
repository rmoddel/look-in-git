import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { git } from './git.js';
import { AppError } from './errors.js';
import { parseStatus } from './parsers.js';
import { FILE_LIMIT, readUntracked, relativePath, validateFilePath } from './paths.js';
import type { Context } from './repositories.js';

export async function discardReview(ctx: Context, input: unknown): Promise<{ path: string; fingerprint: string; size: number | null; deleted: boolean }> {
  const name = relativePath(input);
  const absolute = await validateFilePath(ctx.repo.root, name);
  const [status, index] = await Promise.all([
    git(ctx.repo.root, 'status', ['--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all', '--', name], { config: ctx.config }),
    git(ctx.repo.root, 'ls-files', ['--stage', '-z', '--', name], { config: ctx.config }),
  ]);
  if (!parseStatus(status.output).some(entry => entry.path === name && entry.index !== '?' && !entry.conflict && entry.worktree !== ' ')) throw new AppError(400, 'INVALID_FILE', 'Choose a tracked unstaged file to restore from the index.');
  let data: Buffer | null = null, mode: number | null = null;
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) throw new AppError(400, 'DISCARD_FILE_TYPE', 'Only regular files can be discarded here. Use Git for this file type.');
    if (info.size > FILE_LIMIT) throw new AppError(413, 'DISCARD_TOO_LARGE', 'File discard previews support files up to 1 MiB. Use Git to review and restore this larger file.');
    const contents = await readUntracked(ctx.repo.root, name);
    if (contents.large) throw new AppError(413, 'DISCARD_TOO_LARGE', 'The file grew beyond 1 MiB. Review and restore it with Git.');
    data = contents.data; mode = info.mode;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fingerprint = createHash('sha256').update(JSON.stringify([ctx.repo.root, name, status.output, index.output, mode, data === null])).update(data ?? '').digest('hex');
  return { path: name, fingerprint, size: data?.length ?? null, deleted: data === null };
}
