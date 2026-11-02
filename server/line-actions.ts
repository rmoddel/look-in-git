import { diff } from './service.js';
import { git } from './git.js';
import { withWriteLock } from './actions.js';
import type { Context } from './repositories.js';
import { AppError } from './errors.js';
import { relativePath, validateFilePath } from './paths.js';
import { selectedPatch } from './line-patch.js';

export async function lineAction(ctx: Context, input: unknown) {
  if (!input || typeof input !== 'object') throw new AppError(400, 'INVALID_SELECTION', 'Choose lines in a current file diff.');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['action', 'path', 'scope', 'lines', 'fingerprint', 'confirmed', 'context'].includes(key))) throw new AppError(400, 'INVALID_SELECTION', 'Unknown line action parameter.');
  const name = relativePath(body.path);
  if (!['stage', 'unstage', 'discard'].includes(String(body.action)) || !['staged', 'unstaged', 'untracked'].includes(String(body.scope))) throw new AppError(400, 'INVALID_SELECTION', 'This action is not available for that diff.');
  if ((body.action === 'unstage') !== (body.scope === 'staged')) throw new AppError(400, 'INVALID_SELECTION', 'Stage or discard unstaged changes; unstage changes from the index.');
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 12000 || body.lines.some(line => !Number.isInteger(line) || line < 0 || line > 12000)) throw new AppError(400, 'INVALID_SELECTION', 'Select one or more changed lines.');
  if (body.action === 'discard' && body.confirmed !== true) throw new AppError(400, 'CONFIRM_DISCARD', 'Confirm the warning before discarding selected edits.');
  const selectedLines = body.lines as number[];
  return withWriteLock(ctx.lockKey, async () => {
    const current = await diff(ctx, body.scope as 'staged' | 'unstaged' | 'untracked', name, undefined, undefined, body.context ?? 3);
    if (!current.lineActions) throw new AppError(400, 'LINE_ACTION_UNAVAILABLE', 'Use file actions for binary, truncated, renamed, or metadata-only changes.');
    if (current.fingerprint !== body.fingerprint) throw new AppError(409, 'DIFF_CHANGED', 'This diff changed outside the selection. Refresh and select the lines again.');
    const patch = selectedPatch(current.patch, name, selectedLines, body.action !== 'stage');
    await validateFilePath(ctx.repo.root, name);
    const args = [...(body.action === 'discard' ? [] : ['--cached']), '--unidiff-zero', '--whitespace=nowarn', '-'];
    // The patch is reconstructed exclusively from Git output. Client patches and
    // command fragments are never accepted. Git applies all hunks atomically.
    await git(ctx.repo.root, 'apply', args, { write: true, input: patch });
    return { command: ['git', 'apply', ...args], output: `${new Set(selectedLines).size} selected change lines ${body.action === 'stage' ? 'staged' : body.action === 'unstage' ? 'unstaged' : 'discarded'}.` };
  });
}
