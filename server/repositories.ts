import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath, lstat } from 'node:fs/promises';
import type { Repository } from '../shared/types.js';
import { directory, stringValue } from './paths.js';
import { git, filterOverrides } from './git.js';
import { AppError } from './errors.js';

interface Record extends Repository { gitDir: string; commonDir: string }
export interface Context { repo: Repository; config: string[]; lockKey: string }
const stripLine = (value: string) => value.replace(/\r?\n$/, '');

async function identify(root: string) {
  const top = await git(root, 'rev-parse', ['--show-toplevel']);
  const canonical = await directory(stripLine(top.output));
  const [gitDir, commonDir] = await Promise.all([
    git(canonical, 'rev-parse', ['--absolute-git-dir']),
    git(canonical, 'rev-parse', ['--path-format=absolute', '--git-common-dir']),
  ]);
  return { root: canonical, gitDir: await realpath(stripLine(gitDir.output)), commonDir: await realpath(stripLine(commonDir.output)) };
}

export class Repositories {
  private records = new Map<string, Record>();
  list(): Repository[] { return [...this.records.values()].map(({ id, name, root }) => ({ id, name, root })); }
  async open(input: unknown): Promise<Repository> {
    const supplied = stringValue(input, 'Repository path');
    const target = path.basename(supplied).toLowerCase() === '.git' ? path.dirname(supplied) : supplied;
    const identity = await identify(await directory(target));
    const existing = [...this.records.values()].find(r => r.root === identity.root);
    if (existing) { await this.get(existing.id); return this.public(existing); }
    if (this.records.size >= 50) throw new AppError(400, 'REPO_LIMIT', 'Up to 50 repositories can be open at once. Restart the app to clear the list.');
    const record = { ...identity, id: randomUUID(), name: path.basename(identity.root) || identity.root };
    this.records.set(record.id, record);
    return this.public(record);
  }
  private public({ id, name, root }: Record): Repository { return { id, name, root }; }
  async get(value: unknown): Promise<Context> {
    const id = stringValue(value, 'Repository ID', 100);
    const record = this.records.get(id);
    if (!record) throw new AppError(404, 'REPO_NOT_OPEN', 'Open this repository again before reading it.');
    try {
      if (await realpath(record.root) !== record.root) throw new Error('Root moved');
      const current = await identify(record.root);
      if (current.root !== record.root || current.gitDir !== record.gitDir || current.commonDir !== record.commonDir) throw new Error('Repository changed');
    } catch { throw new AppError(409, 'REPO_CHANGED', 'The repository moved or its Git directory changed. Restart Look-in-Git and open it again.'); }
    return { repo: this.public(record), config: await filterOverrides(record.root), lockKey: process.platform === 'win32' ? record.commonDir.toLowerCase() : record.commonDir };
  }
}

export async function discover(input: unknown): Promise<{ roots: string[]; truncated: boolean }> {
  const start = await directory(input);
  const roots: string[] = [];
  const pending = [{ folder: start, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 800 && roots.length < 50) {
    const item = pending.shift()!;
    visited++;
    try {
      if ((await lstat(item.folder)).isSymbolicLink() || await realpath(item.folder) !== item.folder) continue;
      const entries = await readdir(item.folder, { withFileTypes: true });
      if (entries.some(e => e.name === '.git')) {
        try { const found = await identify(item.folder); if (found.root === item.folder) roots.push(found.root); } catch { /* Skip invalid/bare repositories. */ }
        continue;
      }
      if (item.depth < 3) for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !['node_modules', '.git', '.cache', '$RECYCLE.BIN', 'Windows'].includes(entry.name)) pending.push({ folder: path.join(item.folder, entry.name), depth: item.depth + 1 });
      }
    } catch { /* An inaccessible child does not prevent discovery of siblings. */ }
  }
  return { roots: roots.sort(), truncated: pending.length > 0 };
}
