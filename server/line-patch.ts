import { AppError } from './errors.js';

// Git's quoted-path format uses C escapes, including octal UTF-8 bytes.
function quotePath(value: string) {
  return '"' + [...Buffer.from(value)].map(byte => byte === 34 || byte === 92 ? '\\' + String.fromCharCode(byte) : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0')).join('') + '"';
}
export function canSelectLines(patch: string) {
  return /^@@ /m.test(patch) && !/^(?:rename |copy |old mode |new mode |new file mode 120000|deleted file mode 120000|.* mode 160000)/m.test(patch) && !patch.includes('\0') && !patch.includes('\uFFFD');
}
export function selectedPatch(patch: string, name: string, selected: number[], reverse: boolean) {
  const selection = new Set(selected), valid = new Set<number>();
  const rows = patch.split('\n');
  const hunks: { oldStart: number; newStart: number; rows: { raw: string; index: number }[] }[] = [];
  for (const [index, raw] of rows.entries()) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (match) hunks.push({ oldStart: Number(match[1]), newStart: Number(match[2]), rows: [] });
    else if (hunks.length && [' ', '+', '-', '\\'].includes(raw[0])) {
      hunks.at(-1)!.rows.push({ raw, index });
      if (raw[0] === '+' || raw[0] === '-') valid.add(index);
    }
  }
  if (!selection.size || [...selection].some(index => !valid.has(index))) throw new AppError(400, 'INVALID_SELECTION', 'Select added or removed lines from the current diff.');
  const originalNew = /^--- \/dev\/null$/m.test(patch), originalDeleted = /^\+\+\+ \/dev\/null$/m.test(patch);
  const all = selection.size === valid.size;
  const create = reverse ? originalDeleted : originalNew;
  const remove = all && (reverse ? originalNew : originalDeleted);
  const oldPath = quotePath('a/' + name), newPath = quotePath('b/' + name);
  const originalMode = /^(?:new|deleted) file mode (100\d{3})$/m.exec(patch)?.[1] ?? '100644';
  let output = `diff --git ${oldPath} ${newPath}\n${create ? `new file mode ${originalMode}\n` : remove ? `deleted file mode ${originalMode}\n` : ''}--- ${create ? '/dev/null' : oldPath}\n+++ ${remove ? '/dev/null' : newPath}\n`;
  let offset = 0;
  for (const hunk of hunks) {
    if (!hunk.rows.some(row => selection.has(row.index))) continue;
    const body: string[] = [];
    let includedPrevious = false, oldCount = 0, newCount = 0;
    for (const { raw, index } of hunk.rows) {
      if (raw[0] === '\\') { if (includedPrevious) body.push(raw); continue; }
      const selected = selection.has(index);
      let sign: string | undefined;
      if (raw[0] === ' ') sign = ' ';
      else if (!reverse) sign = raw[0] === '-' ? selected ? '-' : ' ' : selected ? '+' : undefined;
      else sign = raw[0] === '+' ? selected ? '-' : ' ' : selected ? '+' : undefined;
      includedPrevious = sign !== undefined;
      if (sign === undefined) continue;
      body.push(sign + raw.slice(1));
      if (sign !== '+') oldCount++;
      if (sign !== '-') newCount++;
    }
    const sourceStart = reverse ? hunk.newStart : hunk.oldStart;
    // A zero-length range denotes the line before the insertion, not its first line.
    const oldStart = oldCount ? Math.max(1, sourceStart) : sourceStart;
    const newStart = newCount ? (oldCount ? oldStart + offset : oldStart + offset + 1) : oldStart + offset - (oldCount ? 1 : 0);
    output += `@@ -${oldStart},${oldCount} +${Math.max(0, newStart)},${newCount} @@\n${body.join('\n')}\n`;
    offset += newCount - oldCount;
  }
  return output;
}
