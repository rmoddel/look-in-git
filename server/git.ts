import { execFile } from 'node:child_process';
import { AppError } from './errors.js';
import { gitErrorMessage } from './diagnostics.js';

const allowed = new Set(['rev-parse', 'rev-list', 'config', 'status', 'diff', 'diff-tree', 'log', 'for-each-ref', 'symbolic-ref', 'remote', 'check-ref-format', 'ls-files', 'cat-file', '--exec-path', '--version', 'worktree', 'apply']);
const writeAllowed = new Set(['add', 'restore', 'rm', 'commit', 'stash', 'fetch', 'pull', 'push', 'merge', 'rebase', 'switch', 'branch', 'mv', 'cherry-pick', 'revert', 'credential', 'apply', 'clone', 'init', 'remote', 'config', 'tag', 'update-ref', 'worktree', 'reset']);
const baseArgs = [
  '--no-pager', '--no-optional-locks', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.quotePath=false',
  '-c', 'diff.external=', '-c', 'diff.renames=true', '-c', 'diff.algorithm=myers',
  '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never',
];
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(env, {
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: '', LC_ALL: 'C', LANG: 'C',
});

export interface GitResult { output: string; truncated: boolean; code: number }
export interface GitOptions { acceptedCodes?: number[]; limit?: number; allowTruncate?: boolean; config?: string[]; write?: boolean; network?: boolean; input?: string; sensitive?: boolean }
let active = 0;
const queue: (() => void)[] = [];
async function acquire() {
  if (active >= 4) {
    if (queue.length >= 64) throw new AppError(429, 'BUSY', 'Too many Git reads. Please try again shortly.');
    await new Promise<void>(resolve => queue.push(resolve));
  }
  active++;
}
function release() { active--; queue.shift()?.(); }

// Only service-owned argument arrays reach this function; no command endpoint exists.
export async function git(root: string, operation: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  if (!(options.write ? writeAllowed : allowed).has(operation)) throw new AppError(400, 'OPERATION_NOT_ALLOWED', 'That Git operation is unavailable.');
  await acquire();
  try {
    return await new Promise<GitResult>((resolve, reject) => {
      const actionEnv = { ...env };
      if (options.write) {
        // Explicit actions use the user's Git identity, credential helpers and
        // SSH setup. Hooks, signature programs and custom protocols are disabled.
        delete actionEnv.GIT_CONFIG_NOSYSTEM; delete actionEnv.GIT_CONFIG_GLOBAL;
        actionEnv.GIT_OPTIONAL_LOCKS = '1'; actionEnv.GCM_INTERACTIVE = 'Never';
        for (const key of ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']) if (process.env[key]) actionEnv[key] = process.env[key];
      }
      const actionConfig = options.write ? ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.editor=true', '-c', 'sequence.editor=true', '-c', 'submodule.recurse=false', '-c', 'protocol.file.allow=always', '-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always', '-c', 'protocol.ssh.allow=always'] : [];
      // Stash internally uses the ':' match-all pathspec when cleaning its saved
      // untracked files. It accepts no user paths here, so do not inherit literal
      // pathspec mode into that internal Git command.
      const operationBase = operation === 'stash' ? baseArgs.filter(arg => arg !== '--literal-pathspecs') : baseArgs;
      const child = execFile('git', [...operationBase, ...actionConfig, ...(options.config ?? []), '-C', root, operation, ...args], {
        encoding: 'utf8', shell: false, windowsHide: true, env: actionEnv,
        timeout: options.network ? 120000 : 30000, maxBuffer: options.limit ?? 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (!error && options.sensitive && stderr.trim()) return reject(new AppError(422, 'CREDENTIAL_ERROR', 'Your configured Git credential helper reported a problem. Check its installation and authentication settings.'));
        if (!error) return resolve({ output: options.sensitive ? '' : options.write ? [stdout, stderr].filter(Boolean).join('\n') : stdout, truncated: false, code: 0 });
        if (options.sensitive) return reject(new AppError(422, 'CREDENTIAL_ERROR', 'Your configured Git credential helper could not accept the credential. Check its installation and authentication settings.'));
        const code = error.code;
        if (typeof code === 'number' && options.acceptedCodes?.includes(code)) return resolve({ output: stdout, truncated: false, code });
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          if (options.allowTruncate) return resolve({ output: stdout.slice(0, stdout.lastIndexOf('\n')), truncated: true, code: 0 });
          return reject(new AppError(413, 'GIT_OUTPUT_LIMIT', 'This repository returned too much data. Try a smaller comparison.'));
        }
        if (code === 'ENOENT') return reject(new AppError(503, 'GIT_NOT_FOUND', 'Git was not found. Install Git and restart Look-in-Git.'));
        if (error.killed) return reject(new AppError(504, 'GIT_TIMEOUT', 'Git timed out. Refresh to inspect the current state before retrying.'));
        reject(new AppError(422, 'GIT_ERROR', gitErrorMessage([stdout, stderr].filter(Boolean).join('\n').trim() || error.message)));
      });
      child.stdin?.on('error', () => { /* Child exit is handled above. */ });
      child.stdin?.end(options.input ?? '');
    });
  } finally { release(); }
}

// Git status/diff can call clean filters even with --no-ext-diff. Override every
// configured filter entry for this read, including filters defined via includes.
export async function filterOverrides(root: string): Promise<string[]> {
  const result = await git(root, 'config', ['--null', '--name-only', '--get-regexp', String.raw`^filter\..*\.(clean|smudge|process|required)$`], { acceptedCodes: [1] });
  return result.output.split('\0').filter(Boolean).flatMap(key => ['-c', key + (key.endsWith('.required') ? '=false' : '=')]);
}
