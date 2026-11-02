import type { ChangedFile, FileStatus, Scope } from '../shared/types.js';

export interface StatusEntry { path: string; oldPath?: string; index: string; worktree: string; conflict: boolean }
const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// In porcelain v1 -z, renames are destination NUL source NUL. Never trim paths.
export function parseStatus(raw: string): StatusEntry[] {
  const fields = raw.split('\0');
  const result: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Malformed Git status record.');
    const index = record[0], worktree = record[1];
    let oldPath: string | undefined;
    if (/[RC]/.test(index + worktree)) {
      oldPath = fields[++i];
      if (!oldPath) throw new Error('Missing rename source.');
    }
    if (index !== '!') result.push({ path: record.slice(3), oldPath, index, worktree, conflict: conflicts.has(index + worktree) });
  }
  return result;
}

export interface Numstat { path: string; oldPath?: string; added: number | null; deleted: number | null; binary: boolean }
export function parseNumstat(raw: string): Numstat[] {
  const fields = raw.split('\0');
  const result: Numstat[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const record = fields[i];
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw new Error('Malformed Git numstat record.');
    const a = record.slice(0, first), d = record.slice(first + 1, second);
    if (!/^(\d+|-)$/.test(a) || !/^(\d+|-)$/.test(d)) throw new Error('Malformed Git line counts.');
    let name = record.slice(second + 1), oldPath: string | undefined;
    if (!name) { oldPath = fields[++i]; name = fields[++i]; }
    if (!name || oldPath === '') throw new Error('Missing Git numstat path.');
    result.push({ path: name, oldPath, added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d), binary: a === '-' || d === '-' });
  }
  return result;
}

export function parseNameStatus(raw: string, scope: Scope): ChangedFile[] {
  const fields = raw.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const status = fields[i][0] as FileStatus;
    const first = fields[++i];
    const renamed = status === 'R' || status === 'C';
    const name = renamed ? fields[++i] : first;
    if (!name || !first) throw new Error('Missing Git changed-file path.');
    files.push({ path: name, ...(renamed ? { oldPath: first } : {}), status, scope, added: 0, deleted: 0, binary: false });
  }
  return files;
}

export function applyStats(files: ChangedFile[], stats: Numstat[]): ChangedFile[] {
  const byPath = new Map(stats.map(s => [s.path, s]));
  return files.map(file => {
    const stat = byPath.get(file.path);
    return stat ? { ...file, added: stat.added, deleted: stat.deleted, binary: stat.binary } : file;
  });
}
