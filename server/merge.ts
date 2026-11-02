import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { git } from './git.js';
import { AppError } from './errors.js';
import { FILE_LIMIT, readUntracked, relativePath, stringValue, validateFilePath } from './paths.js';
import type { Context } from './repositories.js';
import type { MergeFile } from '../shared/types.js';
import { withWriteLock } from './actions.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function indexStages(ctx: Context, name: string) {
  const result = await git(ctx.repo.root, 'ls-files', ['--unmerged', '-z', '--', name]);
  const stages = new Map<number, string>();
  for (const item of result.output.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]{40,64}) ([123])\t([\s\S]+)$/.exec(item);
    if (!match || match[4] !== name || match[1] !== '100644' && match[1] !== '100755') throw new AppError(400, 'MERGE_FILE_TYPE', 'The embedded merge editor supports regular text files only.');
    stages.set(Number(match[3]), match[2]);
  }
  if (!stages.size) throw new AppError(409, 'NO_CONFLICT', 'This file no longer has an unresolved Git conflict. Refresh to continue.');
  return { stages, signature: digest(result.output) };
}
export async function mergeFile(ctx: Context, input: unknown): Promise<MergeFile> {
  const name = relativePath(input); await validateFilePath(ctx.repo.root, name);
  const { stages, signature } = await indexStages(ctx, name);
  const blobs = await Promise.all([1, 2, 3].map(async stage => {
    const hash = stages.get(stage);
    return hash ? (await git(ctx.repo.root, 'cat-file', ['blob', hash], { limit: FILE_LIMIT })).output : '';
  }));
  let result = '', missing = false, fingerprint = digest('');
  try {
    const working = await readUntracked(ctx.repo.root, name);
    if (working.large) throw new AppError(413, 'MERGE_TOO_LARGE', 'The embedded merge editor supports files up to 1 MiB.');
    result = working.data.toString('utf8'); fingerprint = digest(working.data);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; }
  const marker = /^(<{7,}) /m.exec(result);
  return { path: name, base: blobs[0], ours: blobs[1], theirs: blobs[2], result, fingerprint, indexFingerprint: signature, markerSize: marker?.[1].length ?? 7, binary: [...blobs, result].some(text => text.includes('\0') || text.includes('\uFFFD')), missing };
}
export async function saveMerge(ctx: Context, value: unknown) {
  return withWriteLock(ctx.lockKey, async () => {
    if (!value || typeof value !== 'object') throw new AppError(400, 'INVALID_MERGE', 'Invalid merge result.');
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['path', 'content', 'stage', 'fingerprint', 'indexFingerprint'].includes(key))) throw new AppError(400, 'INVALID_MERGE', 'Unknown merge parameter.');
    const name = relativePath(body.path);
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > FILE_LIMIT || body.content.includes('\0') || typeof body.stage !== 'boolean') throw new AppError(400, 'INVALID_MERGE', 'Provide a text merge result up to 1 MiB.');
    const fingerprint = stringValue(body.fingerprint, 'File fingerprint', 64);
    const indexFingerprint = stringValue(body.indexFingerprint, 'Index fingerprint', 64);
    const current = await mergeFile(ctx, name);
    if (current.binary || current.missing) throw new AppError(400, 'MERGE_FILE_TYPE', 'Binary and deleted conflict files must be resolved with a dedicated Git tool.');
    if (current.fingerprint !== fingerprint || current.indexFingerprint !== indexFingerprint) throw new AppError(409, 'MERGE_CHANGED', 'The file or conflict changed outside this editor. Reload the merge before saving.');
    if (body.stage && new RegExp(`^(?:<{${current.markerSize}}|={${current.markerSize}}|>{${current.markerSize}})(?: |$)`, 'm').test(body.content)) throw new AppError(400, 'CONFLICT_MARKERS', 'Resolve the remaining conflict markers before staging. You can save a draft without staging.');
    const absolute = await validateFilePath(ctx.repo.root, name);
    const before = await lstat(absolute);
    const handle = await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = await handle.stat();
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev || digest(await handle.readFile()) !== fingerprint) throw new AppError(409, 'MERGE_CHANGED', 'The file changed before the save. Reload the merge.');
      await validateFilePath(ctx.repo.root, name);
      const data = Buffer.from(body.content, 'utf8');
      await handle.write(data, 0, data.length, 0); await handle.truncate(data.length); await handle.sync();
    } finally { await handle.close(); }
    if (body.stage) {
      try { await git(ctx.repo.root, 'add', ['--', name], { write: true }); }
      catch (error) { throw new AppError(422, 'MERGE_SAVED_NOT_STAGED', `The result was saved, but Git could not stage it: ${(error as Error).message}`); }
    }
    return { saved: true, staged: body.stage, fingerprint: digest(body.content) };
  });
}
