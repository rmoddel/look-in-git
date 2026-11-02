import { randomUUID } from 'node:crypto';
import type { ActionResult, OperationEntry, Repository } from '../shared/types.js';
import { redactGitOutput } from './diagnostics.js';

// Memory only: bounded to this server session, never browser storage or disk.
export class OperationJournal {
  private entries: OperationEntry[] = [];
  list(repoId: string) { return this.entries.filter(entry => entry.repoId === repoId).map(entry => ({ ...entry, commands: entry.commands.map(args => [...args]) })); }
  async track<T>(repo: Repository, action: string, work: () => Promise<T>): Promise<T> {
    const entry: OperationEntry = { id: randomUUID(), repoId: repo.id, repository: repo.name, action, status: 'running', startedAt: new Date().toISOString(), commands: [], output: '' };
    const start = Date.now();
    this.entries.unshift(entry);
    // Keep in-flight entries, plus the latest 100 completed operations overall.
    let completed = 0;
    this.entries = this.entries.filter(item => item.status === 'running' || ++completed <= 100);
    try {
      const result = await work();
      const output = result as Partial<ActionResult> | undefined;
      entry.status = 'success';
      // Credential approval and form bodies are never journalled.
      if (action !== 'credentials') {
        entry.commands = (output?.commands ?? (output?.command ? [output.command] : [])).map(args => args.map(arg => redactGitOutput(arg).slice(0, 1000)));
        entry.output = redactGitOutput([output?.summary, output?.output].filter(Boolean).join('\n')).slice(0, 12000);
      } else entry.output = 'Credential helper handoff completed.';
      return result;
    } catch (error) {
      entry.status = 'error';
      entry.output = action === 'credentials' ? 'Credential helper handoff failed. Check the configured helper.' : redactGitOutput((error as Error).message).slice(0, 12000);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString(); entry.durationMs = Date.now() - start;
      let completed = 0;
      this.entries = this.entries.filter(item => item.status === 'running' || ++completed <= 100);
    }
  }
}
