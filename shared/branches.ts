import type { Branch } from './types.js';
export function branchRef(branch: Branch) { return `refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`; }
export function branchLabel(ref: string) { return ref.replace(/^refs\/(heads|remotes)\//, ''); }
export function otherWorktree(branch: Branch | undefined, root: string): string | undefined {
  const normalize = (value:string) => { const result=value.replaceAll('\\','/').replace(/\/+$/,''); return /^[a-z]:\//i.test(result) ? result.toLowerCase() : result; };
  return branch?.worktreePath && normalize(branch.worktreePath) !== normalize(root) ? branch.worktreePath : undefined;
}
