import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { AppError } from './errors.js';

export function stringValue(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new AppError(400, 'INVALID_INPUT', `${label} must be a non-empty string of at most ${max} characters.`);
  return value;
}

export async function directory(value: unknown): Promise<string> {
  const input = stringValue(value, 'Folder path');
  if (!path.isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//')) throw new AppError(400, 'INVALID_ROOT', 'Enter an absolute path on a local disk. Network paths are not supported.');
  try {
    const resolved = await realpath(input);
    if (resolved.startsWith('\\\\') || !(await stat(resolved)).isDirectory()) throw new Error('Not a local directory');
    return resolved;
  } catch { throw new AppError(400, 'INVALID_ROOT', 'That local folder does not exist or cannot be read.'); }
}

export function relativePath(value: unknown): string {
  const input = stringValue(value, 'File path');
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || (process.platform === 'win32' && /[\\:]/.test(input))) throw new AppError(400, 'INVALID_PATH', 'A repository-relative file path is required.');
  const segments = input.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git' || (process.platform === 'win32' && /[. ]$/.test(s)))) throw new AppError(400, 'INVALID_PATH', 'The file path contains a forbidden path component.');
  return input;
}

export async function validateFilePath(root: string, value: unknown): Promise<string> {
  const input = relativePath(value);
  let current = root;
  for (const component of input.split('/')) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AppError(403, 'SYMLINK_PATH', 'Symbolic links and junctions are listed, but their content is not opened.');
      const actual = await realpath(current);
      const relative = path.relative(root, actual);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new AppError(403, 'PATH_ESCAPE', 'This path resolves outside the repository.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') break; // Deleted files are valid Git paths.
      throw error;
    }
  }
  return path.join(root, ...input.split('/'));
}

export const FILE_LIMIT = 1024 * 1024;
export async function readUntracked(root: string, relative: string): Promise<{ data: Buffer; large: boolean }> {
  const absolute = await validateFilePath(root, relative);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new AppError(400, 'NOT_REGULAR_FILE', 'Only regular files can be previewed.');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev) throw new AppError(409, 'FILE_CHANGED', 'The file changed while it was being opened. Refresh and try again.');
    // Validate ancestors again after opening to catch junction changes.
    await validateFilePath(root, relative);
    const data = Buffer.alloc(Math.min(after.size, FILE_LIMIT));
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return { data: data.subarray(0, bytesRead), large: after.size > FILE_LIMIT };
  } finally { await handle.close(); }
}
