// Git's output can repeat configured URLs and helper errors. Never retain URL
// credentials or token-bearing queries in responses or the operation journal.
export function redactRemoteUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return raw.replace(/[?#].*$/, '?[redacted]'); }
}

export function redactGitOutput(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+/gi, value => redactRemoteUrl(value))
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|token|password|passwd|client[_-]?secret|secret|signature)\s*[=:]\s*)[^\s,;&]+/gi, '$1[redacted]');
}

export function gitErrorMessage(message: string): string {
  const safe = redactGitOutput(message).slice(0, 4000);
  let hint = '';
  if (/protected branch|repository rule|pre-receive hook declined|GH006|GH013/i.test(safe)) hint = 'The remote rejected this update under its repository rules. Push an allowed feature branch and follow the required review/checks; changing credentials does not bypass branch protection.';
  else if (/authentication failed|permission denied \(publickey\)|could not read (?:username|password)|terminal prompts disabled|invalid username or (?:password|token)/i.test(safe)) hint = 'Use your normal Git command line to sign in with the configured credential helper or unlock your SSH key, then retry. Look-in-Git reuses that same Git setup.';
  else if (/author identity unknown|unable to auto-detect email|tell me who you are/i.test(safe)) hint = 'Configure user.name and user.email for this repository before committing. Commit identity is separate from remote sign-in credentials.';
  else if (/non-fast-forward|not possible to fast-forward|fetch first|tip of your current branch is behind/i.test(safe)) hint = 'Fetch and inspect incoming and outgoing commits, then merge or rebase explicitly before retrying. This action did not force an update.';
  else if (/index\.lock.*(?:exists|unable)|another git process/i.test(safe)) hint = 'Wait for the other Git operation to finish, then refresh. Do not remove a lock while a Git process is still using the repository.';
  return hint ? `${safe}\n\n${hint}` : safe;
}
