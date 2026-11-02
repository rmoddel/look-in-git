# Look-in-Git

Look-in-Git is a desktop Git client for reviewing and managing local repositories. It uses React, TypeScript, Vite, Tailwind CSS, Express, Electron, and your installed Git command-line tools.

The app opens on **Working Changes**. Review staged and unstaged files, inspect diffs, browse commits and branches, compare revisions, manage stashes and worktrees, and run Git actions from the interface. It uses your existing Git credential helper and SSH setup for remote access.

## Run from source on Windows

Install [Node.js 22.12 or later](https://nodejs.org/) and [Git for Windows](https://git-scm.com/download/win). Make sure both are available on `PATH`.

```powershell
git clone https://github.com/OWNER/look-in-git.git
Set-Location look-in-git
npm.cmd install
npm.cmd start
```

Open <http://127.0.0.1:4317>. Stop the app with **Ctrl+C** in the terminal. `npm.cmd` works around PowerShell's default restriction on running `npm.ps1`.

The app discovers repositories in `~/code` by default. Use the repository selector to switch projects, or **+** to open another local repository. You can change the discovery folder with `LOOK_IN_GIT_DISCOVERY_ROOT` or open one repository at startup with `LOOK_IN_GIT_REPO`.

## Development commands

```powershell
npm.cmd run dev       # Frontend hot reload with the local API
npm.cmd test          # Automated tests using disposable Git repositories
npm.cmd run build     # TypeScript checks and production frontend build
npm.cmd run demo      # Start with a disposable demo repository
npm.cmd run desktop:dev # Run the Electron desktop app
```

The app listens on `127.0.0.1` only. If port 4317 is busy, choose another port before starting:

```powershell
$env:LOOK_IN_GIT_PORT = '4318'
npm.cmd start
```

## Git features

- See changed files once, in their original folders, with clear new, modified, deleted, renamed, and conflict statuses.
- Review syntax-highlighted diffs in inline or side-by-side view. Stage or unstage whole files or selected lines; discard actions show a warning.
- Write commit messages, commit staged changes, and inspect history, branches, tags, stashes, and reflog entries.
- Compare commits or branches, merge, rebase, cherry-pick, revert, fetch, pull, push, and sync with an upstream branch.
- Switch branches safely. Switching to a remote branch can save current work in a stash and offer to restore it afterward.
- Manage Git worktrees as separate working folders. Create, open, compare, move, lock, repair, and remove worktrees with clear status and confirmation.
- Review changes from multiple worktrees or AI coding agents side by side. Agent labels are assigned by the user; Git cannot identify which agent owns a worktree.
- Resolve text conflicts in the embedded three-way merge editor. Binary and some special-file conflicts need an external Git tool.
- Use snapshots and recovery options for supported reset, amend, checkout, and discard workflows.

### Safer Git actions

Important operations show the source, destination, and expected effect before running. Push does not force; pull uses fast-forward only. Branch deletion requires Git to confirm the branch is merged. Switches can save working changes in a stash and offer to restore them afterward. Recovery options keep a reference to the previous commit where supported. Discarding uncommitted changes can still permanently lose those edits.

Remote operations use your normal Git credential helper, SSH keys, and agent. Look-in-Git does not store your Git password or token in its settings.

## Electron desktop builds

Electron packages include the app's Node.js backend, so client machines do not need Node.js or npm. **Git must still be installed** and available on `PATH`; Look-in-Git uses that installation and its credential configuration.

```powershell
npm.cmd run desktop:build:win # Windows installer and portable executable
npm.cmd run desktop:build:mac # macOS DMG; run on macOS
```

Desktop builds use the issuer's public key at `artifacts/issuer/public.pem`. Keep the matching private key out of the repository and out of client packages. The GitHub Actions release workflow also expects the public key in the `LOOK_IN_GIT_LICENSE_PUBLIC_KEY` repository secret. The current packages are unsigned; Windows and macOS signing, macOS notarization, and clean-machine installation tests are still required before a general client release.

The source developer build does not require a license. Client packages include the configured 30-day offline trial and signed license activation. The trial and activation workflow is local and does not contact a licensing server.

## Safety and privacy

All Git operations run locally through fixed argument lists with `child_process.execFile`; the app does not execute user-supplied shell commands. The local server binds to `127.0.0.1`, validates browser requests and repository paths, and rejects paths that escape a repository. There is no cloud backend, account, database, or telemetry.

Some Git actions change repository data. Look-in-Git previews important operations and provides recovery workflows where possible, but discarded uncommitted changes may not be recoverable. Review the action and target shown in the app before confirming it.

Tests use temporary repositories and local bare remotes. They do not change your existing projects or contact real Git hosting services.

## Project layout

| Folder | Contents |
| --- | --- |
| `src/` | React interface, diff viewer, and styles |
| `server/` | Express API and Git operations |
| `shared/` | Shared API types |
| `electron/` | Desktop window and backend lifecycle |
| `scripts/` | Startup, packaging, and test helpers |
| `tests/` | Git parsing and API tests |
