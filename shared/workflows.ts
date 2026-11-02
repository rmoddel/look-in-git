export type WorkflowKind = 'patch-apply' | 'snapshot' | 'discard-all' | 'reset' | 'amend' | 'worktree-create' | 'fetch-all' | 'tag-push' | 'sync' | 'checkout-revision';
export interface WorkflowInput {
  action: WorkflowKind;
  target?: string;
  name?: string;
  parent?: string;
  folder?: string;
  message?: string;
  mode?: 'soft' | 'mixed';
  patch?: string;
  remote?: string;
  fingerprint?: string;
}
export interface WorkflowReview { fingerprint: string; title: string; detail: string; files: string[]; head: string; target?: string }
export type { WorktreeInfo } from './worktrees.js';
