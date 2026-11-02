import { describe, expect, it } from 'vitest';
import { applyStats, parseNameStatus, parseNumstat, parseStatus } from '../server/parsers';
import { parsePatch, splitLines } from '../src/diff-model';

describe('porcelain v1 -z', () => {
  it('preserves spaces, tabs, newlines, quotes, unicode and backslashes literally', () => {
    const paths = [' leading and trailing ', 'a\tb\nc.txt', 'quote"name', '日本語/é.txt', 'literal\\name'];
    expect(parseStatus(paths.map(p => ` M ${p}\0`).join('')).map(p => p.path)).toEqual(paths);
  });
  it('reads rename destination before the separate NUL-terminated source', () => {
    expect(parseStatus('RM new\nname\0old\tname\0?? next.txt\0')).toEqual([
      { index: 'R', worktree: 'M', path: 'new\nname', oldPath: 'old\tname', conflict: false },
      { index: '?', worktree: '?', path: 'next.txt', oldPath: undefined, conflict: false },
    ]);
  });
  it('handles copied files, both staging states, deletion, conflicts and ignored entries', () => {
    const entries = parseStatus('C  copy\0source\0MM both\0 D deleted\0UU conflict\0!! ignored\0');
    expect(entries).toHaveLength(4);
    expect(entries[0].oldPath).toBe('source');
    expect(entries[1]).toMatchObject({ index: 'M', worktree: 'M' });
    expect(entries[3].conflict).toBe(true);
  });
  it('handles empty output and rejects incomplete renames', () => {
    expect(parseStatus('')).toEqual([]);
    expect(() => parseStatus('R  missing\0')).toThrow('Missing rename');
  });
});
describe('NUL-delimited diff metadata', () => {
  it('parses tabs in names, renames, and binary counts', () => {
    expect(parseNumstat('12\t3\tfile\tname\0-\t-\tbinary\0' + '1\t0\t\0old\nname\0new name\0')).toEqual([
      { path: 'file\tname', added: 12, deleted: 3, binary: false },
      { path: 'binary', added: null, deleted: null, binary: true },
      { path: 'new name', oldPath: 'old\nname', added: 1, deleted: 0, binary: false },
    ]);
  });
  it('parses name-status rename order and joins stats by exact path', () => {
    const files = parseNameStatus('R100\0old file\0new file\0M\0a\tb\0', 'commit');
    expect(files[0]).toMatchObject({ status: 'R', oldPath: 'old file', path: 'new file' });
    expect(applyStats(files, parseNumstat('2\t1\ta\tb\0'))[1]).toMatchObject({ added: 2, deleted: 1 });
  });
});
describe('diff presentation', () => {
  it('keeps correct line numbers across hunks and pairs replacement blocks', () => {
    const lines = parsePatch('--- a/file\n+++ b/file\n@@ -4,2 +4,3 @@ fn\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-x\n+y\n\\ No newline at end of file\n');
    expect(lines[1]).toMatchObject({ old: 4, next: 4 });
    expect(lines[3]).toMatchObject({ kind: 'add', next: 5 });
    const rows = splitLines(lines);
    expect(rows[2]).toMatchObject({ left: { text: 'old', old: 5 }, right: { text: 'new', next: 5 } });
    expect(rows[3]).toMatchObject({ left: undefined, right: { text: 'extra', next: 6 } });
    expect(lines.at(-2)).toMatchObject({ next: 21, text: 'y' });
  });
  it('treats added lines starting with ++ as file content', () => {
    expect(parsePatch('@@ -0,0 +1 @@\n+++not a header\n')[1]).toMatchObject({ text: '++not a header', next: 1 });
  });
});
