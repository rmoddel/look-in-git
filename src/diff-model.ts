export type LineKind = 'context' | 'add' | 'delete' | 'hunk' | 'note';
export interface DiffLine { kind: LineKind; text: string; old?: number; next?: number; patchLine: number }
export interface SplitLine { left?: DiffLine; right?: DiffLine; header?: DiffLine }

export function parsePatch(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let old = 0, next = 0, inHunk = false;
  for (const [patchLine, raw] of patch.split('\n').entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; result.push({ kind: 'hunk', text: raw, patchLine }); continue; }
    if (!inHunk) continue;
    if (raw.startsWith('diff --git')) { inHunk = false; continue; }
    const text = raw.slice(1).replace(/\r$/, '');
    if (raw[0] === '+') result.push({ kind: 'add', text, next: next++, patchLine });
    else if (raw[0] === '-') result.push({ kind: 'delete', text, old: old++, patchLine });
    else if (raw[0] === ' ') result.push({ kind: 'context', text, old: old++, next: next++, patchLine });
    else if (raw[0] === '\\') result.push({ kind: 'note', text: raw, patchLine });
  }
  return result;
}

export function splitLines(lines: DiffLine[]): SplitLine[] {
  const rows: SplitLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === 'hunk' || line.kind === 'note') rows.push({ header: line });
    else if (line.kind === 'context') rows.push({ left: line, right: line });
    else {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (i < lines.length && ['delete', 'add'].includes(lines[i].kind)) {
        (lines[i].kind === 'delete' ? removed : added).push(lines[i]);
        i++;
      }
      i--;
      for (let j = 0; j < Math.max(removed.length, added.length); j++) rows.push({ left: removed[j], right: added[j] });
    }
  }
  return rows;
}
