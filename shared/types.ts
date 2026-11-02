export type Scope = 'unstaged' | 'staged' | 'untracked' | 'commit' | 'compare';
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  scope: Scope;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  conflict?: boolean;
  note?: string;
}
export interface Repository { id: string; name: string; root: string }
export interface WorkingCopy {
  branch: string;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  refreshedAt: string;
}
export interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs?: string[];
}
export interface Branch {
  name: string;
  hash: string;
  current: boolean;
  remote: boolean;
  subject: string;
  date: string;
  worktreePath?: string;
}
export interface Comparison { files: ChangedFile[]; from: string | null; to: string }
export interface DiffResult {
  patch: string;
  binary: boolean;
  truncated: boolean;
  fingerprint?: string;
  lineActions?: boolean;
  message?: string;
}
export interface ActionRecovery { stashed?: Stash; worktree?: { path: string; branch: string } }
export interface ApiError { error: { code: string; message: string; recovery?: ActionRecovery } }

export type ActionKind = 'stage' | 'unstage' | 'stage-all' | 'unstage-all' | 'commit' | 'stash-save' | 'stash-apply' | 'stash-pop' | 'fetch' | 'pull' | 'push' | 'merge' | 'squash' | 'rebase' | 'switch' | 'branch-create' | 'branch-delete' | 'branch-recover' | 'rename' | 'discard' | 'cherry-pick' | 'revert' | 'merge-abort' | 'rebase-abort' | 'cherry-pick-abort' | 'revert-abort' | 'rebase-continue' | 'cherry-pick-continue' | 'revert-continue';
export interface ActionRequest { action: ActionKind; path?: string; target?: string; message?: string; remote?: string; remoteBranch?: string; discardFingerprint?: string; includeUntracked?: boolean; stash?: string; stashHash?: string; stashBeforeSwitch?: boolean; reviewFingerprint?: string }
export interface ActionResult { command: string[]; commands?: string[][]; output: string; stashed?: Stash; summary?: string; switchedBranch?: string }
export interface ActionReview {
  action: 'merge' | 'squash' | 'push' | 'pull'; fingerprint: string; branch: string; head: string | null;
  source: string; destination: string; sourceKind: string; destinationKind: string;
  effect: string; details: string[]; warnings: string[]; blocked: string | null; submitLabel: string;
  remoteUrls: string[]; remoteBranch?: string; incoming: number | null; outgoing: number | null; countsAreCached: boolean;
}
export interface Stash { ref: string; hash: string; subject: string; date: string }
export interface ActionOptions { remotes: string[]; branches: Branch[]; stashes: Stash[]; branch: string; upstream?: {remote: string; branch: string}; mergeInProgress: boolean; rebaseInProgress: boolean; cherryPickInProgress: boolean; revertInProgress: boolean }
export interface MergeFile { path: string; base: string; ours: string; theirs: string; result: string; fingerprint: string; indexFingerprint: string; markerSize: number; binary: boolean; missing: boolean; }

export interface CommitDetail extends Commit { body: string; email: string; committer: string; committerEmail: string; committedDate: string; decorations: string }
export interface ReflogEntry { hash: string; selector: string; subject: string; date: string; author: string }
export interface StashPreview { stash: Stash; staged: Comparison; unstaged: Comparison; untracked: Comparison | null }
export interface RemoteInfo { name: string; fetchUrls: string[]; pushUrls: string[]; fingerprint: string }
export interface TagInfo { name: string; hash: string; subject: string; date: string; annotated: boolean }
export interface RepositoryTools { remotes: RemoteInfo[]; tags: TagInfo[]; identity: {name: string; email: string}; policy: {hooksEnabled: false; signingEnabled: false} }
export interface OperationEntry { id: string; repoId: string; repository: string; action: string; status: 'running' | 'success' | 'error'; startedAt: string; finishedAt?: string; durationMs?: number; commands: string[][]; output: string }
export interface DiscardReview { path: string; fingerprint: string; size: number | null; deleted: boolean }
export interface LicenseStatus { mode: 'development' | 'trial' | 'licensed' | 'expired' | 'clock-error' | 'invalid'; allowed: boolean; daysRemaining: number | null; expiresAt: string | null; customer?: string; deviceId: string; message: string }
