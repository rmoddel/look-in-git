import type { Context } from './repositories.js';
import { git } from './git.js';
import { stringValue } from './paths.js';
import { AppError } from './errors.js';

export interface CredentialRemote { name: string; protocol: string; host: string; path: string }
export function describeRemote(name: string, raw: string): CredentialRemote {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { name, protocol: 'file', host: 'Local disk', path: raw };
  try {
    const url = new URL(raw);
    return { name, protocol: url.protocol.replace(':', ''), host: url.host, path: url.pathname.replace(/^\//, '') };
  } catch {
    const ssh = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(raw);
    return { name, protocol: ssh && !/^[A-Za-z]:[\\/]/.test(raw) ? 'ssh' : 'file', host: ssh?.[1] ?? 'Local disk', path: ssh?.[2] ?? raw };
  }
}
export async function credentialOptions(ctx: Context) {
  const remotes = (await git(ctx.repo.root, 'remote', [])).output.split(/\r?\n/).filter(Boolean);
  const entries: (CredentialRemote & { configured: boolean })[] = [];
  for (const name of remotes) {
    const url = (await git(ctx.repo.root, 'remote', ['get-url', '--push', '--', name])).output.replace(/\r?\n$/, '');
    const remote = describeRemote(name, url);
    const helper = remote.protocol === 'https' ? await git(ctx.repo.root, 'config', ['--get-urlmatch', 'credential.helper', `https://${remote.host}/${remote.path}`], { acceptedCodes: [1] }) : null;
    entries.push({ ...remote, configured: !!helper?.output.trim() });
  }
  return { remotes: entries, helper: 'configured Git credential helper', available: entries.some(remote => remote.configured), store: 'your configured Git credential helper' };
}
export function credentialInput(remote: CredentialRemote, username: unknown, secret: unknown) {
  if (remote.protocol !== 'https') throw new AppError(400, 'HTTPS_REQUIRED', 'Saved tokens are supported for HTTPS remotes. SSH remotes use your SSH agent and keys.');
  const user = stringValue(username, 'Username', 500), password = stringValue(secret, 'Token or password', 8000);
  if ([remote.host, remote.path, user, password].some(value => /[\r\n\0]/.test(value))) throw new AppError(400, 'INVALID_CREDENTIAL', 'Credential fields cannot contain newlines or NUL characters.');
  return `protocol=https\nhost=${remote.host}\npath=${remote.path}\nusername=${user}\npassword=${password}\n\n`;
}
export async function saveCredential(ctx: Context, input: unknown) {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['remote', 'username', 'secret'].includes(key))) throw new AppError(400, 'INVALID_CREDENTIAL', 'Choose a remote and provide credentials.');
  const options = await credentialOptions(ctx);
  const remote = options.remotes.find(item => item.name === value.remote);
  if (!remote) throw new AppError(400, 'INVALID_REMOTE', 'Choose an existing repository remote.');
  const payload = credentialInput(remote, value.username, value.secret);
  if (!remote.configured) throw new AppError(503, 'CREDENTIAL_HELPER_MISSING', 'No Git credential helper is configured for this remote. Configure a helper in Git first, then reopen this dialog.');
  await git(ctx.repo.root, 'credential', ['approve'], { write: true, sensitive: true, input: payload });
  return { saved: true, store: options.store, host: remote.host };
}
