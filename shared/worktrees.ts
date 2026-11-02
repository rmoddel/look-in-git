export interface WorktreeInfo {
  path: string;
  name: string;
  head: string;
  branch: string;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  detached: boolean;
  locked: boolean;
  lockReason: string;
  prunable: boolean;
  prunableReason: string;
  main: boolean;
}

export type WorktreeAction = 'create' | 'move' | 'lock' | 'unlock' | 'remove' | 'repair' | 'prune';
export interface WorktreeActionInput {
  action: WorktreeAction;
  path?: string;
  target?: string;
  branch?: string;
  newBranch?: string;
  base?: string;
  confirm?: boolean;
  deleteBranch?: boolean;
}
