import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { ActionResult, RemoteInfo, Repository, RepositoryTools, TagInfo } from '../shared/types.js';
import { withWriteLock } from './actions.js';
import { redactGitOutput, redactRemoteUrl } from './diagnostics.js';
import { AppError } from './errors.js';
import { filterOverrides, git } from './git.js';
import { directory, stringValue } from './paths.js';
import { Repositories, type Context } from './repositories.js';
import { branches, resolveRef } from './service.js';

type Input = Record<string, unknown>;
const read = (ctx: Context, op: string, args: string[], extra = {}) => git(ctx.repo.root, op, args, { config: ctx.config, ...extra });
function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_INPUT', 'Supply the repository operation details.');
  return value as Input;
}
function fields(input: Input, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new AppError(400, 'INVALID_INPUT', 'Unknown repository operation parameter.');
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// Onboarding is restricted to new local folders. Check every existing ancestor:
// accepting a canonical final path alone would silently follow a junction.
export async function localDirectory(value: unknown): Promise<string> {
  const input = stringValue(value, 'Local folder');
  if (!path.isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//') || input.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new AppError(400, 'INVALID_ROOT', 'Choose an absolute local folder outside Git metadata, without traversal components.');
  const result = await directory(input);
  const normalized = path.resolve(input);
  let ancestor = path.parse(normalized).root;
  for (const component of normalized.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    if ((await lstat(ancestor)).isSymbolicLink()) throw new AppError(403, 'SYMLINK_PATH', 'Choose a local folder without symbolic links or junctions in its path.');
  }
  if (!samePath(normalized, result)) throw new AppError(403, 'SYMLINK_PATH', 'The local folder resolves to a different location. Choose its actual path.');
  return result;
}

export function folderName(value: unknown) {
  const name = stringValue(value, 'New folder name', 100);
  if (name === '.' || name === '..' || name.toLowerCase() === '.git' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || name !== name.trim() || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) throw new AppError(400, 'INVALID_FOLDER_NAME', 'Enter one Windows-compatible folder name, without a path, trailing dot, or reserved device name.');
  return name;
}

async function remoteUrl(value: unknown): Promise<string> {
  const raw = stringValue(value, 'Repository URL', 2048);
  if (raw !== raw.trim() || /[\x00-\x1f\x7f]/.test(raw) || raw.startsWith('-')) throw new AppError(400, 'INVALID_REMOTE_URL', 'Use an HTTPS, SSH, or absolute local repository address.');
  if (path.isAbsolute(raw)) return localDirectory(raw);
  if (/^[a-z]:/i.test(raw)) throw new AppError(400, 'INVALID_REMOTE_URL', 'Local repository addresses must be absolute paths, including the drive separator.');
  if (/\s/.test(raw)) throw new AppError(400, 'INVALID_REMOTE_URL', 'Repository URLs cannot contain whitespace. Encode spaces in URL paths.');
  if (/^(?:https|ssh):\/\//i.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new AppError(400, 'INVALID_REMOTE_URL', 'Enter a valid HTTPS or SSH repository address.'); }
    if (!url.hostname || url.hostname.startsWith('-') || url.password || url.search || url.hash || raw.includes('\\') || /[\x00-\x1f\x7f]/.test(decodeURIComponentSafe(url.pathname)) || (url.protocol === 'https:' && url.username) || (url.protocol === 'ssh:' && url.username && !/^[a-z0-9_][a-z0-9_.-]*$/i.test(url.username))) throw new AppError(400, 'INVALID_REMOTE_URL', 'Repository addresses cannot contain passwords, HTTPS usernames, query strings, or fragments. Use your system Git credentials.');
    return raw;
  }
  // Git's scp-style SSH syntax. Arbitrary transport helpers and option-like
  // host/path values are deliberately excluded.
  if (/^(?:[a-z0-9_][a-z0-9_.-]*@)?(?:[a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\]):[^:\\-][^?#\s]*$/i.test(raw) && !raw.includes('://')) return raw;
  throw new AppError(400, 'INVALID_REMOTE_URL', 'Use HTTPS, SSH (including git@host:owner/repository.git), or an existing absolute local folder. Credentials are supplied by your normal Git setup.');
}
function decodeURIComponentSafe(value: string) {
  try { return decodeURIComponent(value); } catch { throw new AppError(400, 'INVALID_REMOTE_URL', 'The repository address contains invalid URL encoding.'); }
}
async function refName(root: string, kind: 'heads' | 'tags' | 'remotes', value: unknown, config: string[] = []) {
  const name = stringValue(value, kind === 'tags' ? 'Tag name' : 'Branch name', 250);
  if (name.startsWith('-') || name.startsWith('refs/') || name === 'HEAD' || /[\x00-\x20\x7f]/.test(name) || (await git(root, 'check-ref-format', [`refs/${kind}/${name}`], { config, acceptedCodes: [1, 128] })).code !== 0) throw new AppError(400, 'INVALID_REF_NAME', 'Enter a valid new Git reference name.');
  return name;
}
function remoteName(value: unknown) {
  const name = stringValue(value, 'Remote name', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith('.') || name.includes('..')) throw new AppError(400, 'INVALID_REMOTE', 'Use a remote name containing letters, numbers, dots, underscores, or hyphens.');
  return name;
}

export async function createRepository(repositories: Repositories, value: unknown): Promise<Repository> {
  const input = object(value); fields(input, ['kind', 'parent', 'name', 'url', 'branch']);
  if (input.kind !== 'init' && input.kind !== 'clone') throw new AppError(400, 'INVALID_INPUT', 'Choose initialize or clone.');
  if (input.kind === 'init' && input.url !== undefined) throw new AppError(400, 'INVALID_INPUT', 'Initialize does not accept a remote URL.');
  const parent = await localDirectory(input.parent), name = folderName(input.name);
  const destination = path.join(parent, name);
  const config = await filterOverrides(parent);
  const branch = input.branch === undefined ? (input.kind === 'init' ? 'main' : undefined) : await refName(parent, 'heads', input.branch, config);
  const url = input.kind === 'clone' ? await remoteUrl(input.url) : undefined;
  return withWriteLock(parent, async () => {
    if (repositories.list().length >= 50) throw new AppError(400, 'REPO_LIMIT', 'Up to 50 repositories can be open at once. Restart the app before creating another.');
    const parentIdentity = await lstat(parent);
    const inside = await git(parent, 'rev-parse', ['--git-dir'], { config, acceptedCodes: [128, 1] });
    if (inside.code === 0) throw new AppError(409, 'PARENT_IS_REPOSITORY', 'Choose a parent folder outside existing Git repositories so creating this project does not change another working copy.');
    await localDirectory(parent);
    try { await mkdir(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError(409, 'TARGET_EXISTS', 'That folder already exists. Choose a new folder name; existing folders are never initialized or overwritten.');
      throw new AppError(400, 'CREATE_FOLDER_FAILED', `Cannot create the new folder: ${destination}`);
    }
    try {
      const current = await lstat(parent);
      if (current.dev !== parentIdentity.dev || current.ino !== parentIdentity.ino || !samePath(await localDirectory(destination), destination)) throw new AppError(409, 'FOLDER_CHANGED', 'The destination changed while it was being created.');
      if (input.kind === 'init') await git(destination, 'init', ['--template=', `--initial-branch=${branch}`, '--'], { write: true, config });
      else await git(destination, 'clone', ['--template=', '--no-hardlinks', '--no-recurse-submodules', ...(branch ? ['--branch', branch] : []), '--', url!, '.'], { write: true, network: true, config });
      return await repositories.open(destination);
    } catch (error) {
      const message = error instanceof Error ? redactGitOutput(error.message) : 'Git did not complete.';
      throw new AppError(error instanceof AppError ? error.status : 422, 'REPOSITORY_CREATE_FAILED', `${message}\n\nNew project path: ${destination}\nLook-in-Git has not removed this folder or any partial clone. Inspect it before retrying with another name.`);
    }
  });
}

async function remotes(ctx: Context): Promise<RemoteInfo[]> {
  const names = (await read(ctx, 'remote', [])).output.split(/\r?\n/).filter(Boolean);
  return Promise.all(names.map(async name => {
    // get-url expands insteadOf/pushInsteadOf, making the actual destination
    // visible; the raw configuration also participates in stale-review checks.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [fetch, push, config] = await Promise.all([
      read(ctx, 'remote', ['get-url', '--all', '--', name], { acceptedCodes: [2] }),
      read(ctx, 'remote', ['get-url', '--push', '--all', '--', name], { acceptedCodes: [2] }),
      read(ctx, 'config', ['--null', '--get-regexp', `^remote\\.${escaped}\\.`], { acceptedCodes: [1] }),
    ]);
    const fetchUrls = fetch.output.split(/\r?\n/).filter(Boolean), pushUrls = push.output.split(/\r?\n/).filter(Boolean);
    return { name, fetchUrls: fetchUrls.map(redactRemoteUrl), pushUrls: pushUrls.map(redactRemoteUrl), fingerprint: createHash('sha256').update(JSON.stringify([name, config.output, fetchUrls, pushUrls])).digest('hex') };
  }));
}
async function tags(ctx: Context): Promise<TagInfo[]> {
  const output = (await read(ctx, 'for-each-ref', ['--sort=-creatordate', '--format=%(refname)%00%(objectname)%00%(subject)%00%(creatordate:iso-strict)%00%(objecttype)%00', 'refs/tags/'])).output;
  const parts = output.split('\0'), result: TagInfo[] = [];
  for (let i = 0; i + 4 < parts.length; i += 5) {
    const ref = parts[i].replace(/^\r?\n/, '');
    if (ref.startsWith('refs/tags/')) result.push({ name: ref.slice(10), hash: parts[i + 1], subject: parts[i + 2], date: parts[i + 3], annotated: parts[i + 4] === 'tag' });
  }
  return result;
}

export async function managementInfo(ctx: Context): Promise<RepositoryTools> {
  const [remoteList, tagList, name, email] = await Promise.all([
    remotes(ctx), tags(ctx),
    read(ctx, 'config', ['--get', 'user.name'], { acceptedCodes: [1] }),
    read(ctx, 'config', ['--get', 'user.email'], { acceptedCodes: [1] }),
  ]);
  return { remotes: remoteList, tags: tagList, identity: { name: name.output.trim(), email: email.output.trim() }, policy: { hooksEnabled: false, signingEnabled: false } };
}

export async function manageRepository(ctx: Context, value: unknown): Promise<ActionResult> {
  const input = object(value);
  const schemas: Record<string, string[]> = {
    'remote-add': ['name', 'url'], 'remote-set-url': ['name', 'url', 'expectedFingerprint'], 'remote-remove': ['name', 'expectedFingerprint'],
    'tag-create': ['name', 'target', 'message'], 'tag-delete': ['name', 'expectedHash'], 'upstream-set': ['target'], 'branch-rename': ['target', 'newName'],
  };
  const action = stringValue(input.action, 'Repository action', 40);
  if (!Object.hasOwn(schemas, action)) throw new AppError(400, 'INVALID_ACTION', 'That repository action is unavailable.');
  fields(input, ['action', ...schemas[action]]);
  return withWriteLock(ctx.lockKey, async () => {
    let operation = '', args: string[] = [], summary = '';
    if (action.startsWith('remote-')) {
      const name = remoteName(input.name), current = (await remotes(ctx)).find(remote => remote.name === name);
      if (action === 'remote-add') {
        if (current) throw new AppError(409, 'REMOTE_EXISTS', 'A remote with that name already exists.');
        operation = 'remote'; args = ['add', '--', name, await remoteUrl(input.url)];
        summary = `Added ${name}. Fetch when you are ready to download its branches.`;
      } else {
        if (!current) throw new AppError(409, 'REMOTE_CHANGED', 'This remote no longer exists. Refresh repository settings.');
        if (typeof input.expectedFingerprint !== 'string' || input.expectedFingerprint !== current.fingerprint) throw new AppError(409, 'REMOTE_CHANGED', 'The remote configuration changed. Refresh and review its current addresses before continuing.');
        operation = 'remote'; args = action === 'remote-set-url' ? ['set-url', '--', name, await remoteUrl(input.url)] : ['remove', '--', name];
        summary = action === 'remote-set-url' ? `Updated ${name}'s fetch address. Explicit push addresses are unchanged.` : `Removed the local ${name} configuration and its remote-tracking refs. Nothing was deleted from the remote host.`;
      }
    } else if (action === 'tag-create') {
      const name = await refName(ctx.repo.root, 'tags', input.name, ctx.config), target = await resolveRef(ctx, input.target);
      if ((await tags(ctx)).some(tag => tag.name === name)) throw new AppError(409, 'TAG_EXISTS', 'That tag already exists. Existing tags are never overwritten.');
      const message = input.message === undefined ? undefined : stringValue(input.message, 'Tag message', 10000);
      if (message !== undefined && !message.trim()) throw new AppError(400, 'INVALID_INPUT', 'Enter an annotation message or create a lightweight tag.');
      operation = 'tag'; args = [...(message ? ['--annotate', '--no-sign', '--message', message] : []), '--', name, target];
      summary = `Created ${message ? 'annotated' : 'lightweight'} tag ${name} locally. It has not been pushed.`;
    } else if (action === 'tag-delete') {
      const name = await refName(ctx.repo.root, 'tags', input.name, ctx.config), current = (await tags(ctx)).find(tag => tag.name === name);
      if (!current || typeof input.expectedHash !== 'string' || current.hash !== input.expectedHash) throw new AppError(409, 'TAG_CHANGED', 'This tag moved or was removed. Refresh and review it before deleting.');
      operation = 'update-ref'; args = ['-d', `refs/tags/${name}`, current.hash];
      summary = `Deleted ${name} locally. Remote tags are unchanged.`;
    } else if (action === 'upstream-set') {
      const target = stringValue(input.target, 'Remote-tracking branch', 300);
      const options = await branches(ctx), current = options.find(branch => branch.current && !branch.remote);
      if (!current) throw new AppError(409, 'DETACHED_HEAD', 'Switch to a local branch with a commit before setting an upstream.');
      if (!options.some(branch => branch.remote && `refs/remotes/${branch.name}` === target)) throw new AppError(400, 'INVALID_BRANCH', 'Choose an existing remote-tracking branch. Fetch first if it is missing.');
      operation = 'branch'; args = [`--set-upstream-to=${target}`, '--', current.name];
      summary = `${current.name} now tracks ${target.slice(13)}. No commits were downloaded or pushed.`;
    } else if (action === 'branch-rename') {
      const target = stringValue(input.target, 'Local branch', 300), options = await branches(ctx);
      const current = options.find(branch => !branch.remote && (`refs/heads/${branch.name}` === target || branch.name === target));
      if (!current) throw new AppError(400, 'INVALID_BRANCH', 'Choose an existing local branch to rename.');
      const name = await refName(ctx.repo.root, 'heads', input.newName, ctx.config);
      if (options.some(branch => !branch.remote && branch.name === name)) throw new AppError(409, 'BRANCH_EXISTS', 'A local branch with that name already exists.');
      operation = 'branch'; args = ['--move', '--', current.name, name];
      summary = `Renamed ${current.name} to ${name} locally. Its configured upstream was preserved; remote branches were not renamed.`;
    }
    const result = await git(ctx.repo.root, operation, args, { write: true, config: ctx.config });
    return { command: ['git', operation, ...args].map(redactGitOutput), output: redactGitOutput(result.output).trim() || 'Completed successfully.', summary };
  });
}
