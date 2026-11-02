# Look-in-Git

A local Git workspace built with React, TypeScript, Vite, Tailwind CSS, Express, and the Git CLI. Working Changes opens first. There is no database, app account, cloud backend, telemetry, or .NET dependency.

V2 adds explicit Git write actions, credentials, embedded merge resolution, and selected-line operations. Opening a repository and refreshing its views remain read-only; changes happen when you invoke an action.

Version 2.1 adds searchable history, file history, full commit details, stash previews, reflog recovery branches, a command palette, commit drafts, an operation journal, repository creation/cloning, remote/tag management, and distributable Windows builds with a **30-day offline trial**.

Version 2.2 adds compact desktop menus, reviewed snapshots and recovery actions, patch import/export, native Git worktree management, upstream sync, and portable preferences. The menus use the same fixed Git operations as the rest of the app.

## Windows PowerShell setup

Install Node.js **22.12 or later** and Git for Windows. Both must be on `PATH`. Use a current Git release supporting `switch`, `restore`, and `--path-format=absolute` (Git 2.31+).

```powershell
# Run this from the directory containing the project checkout.
Set-Location .\look-in-git
npm.cmd install
npm.cmd start
```

After the one-time install, **`npm.cmd start` is the single startup command**. It checks/compiles the TypeScript backend, builds the frontend, and serves both at **http://127.0.0.1:4317**. Open that exact address. Stop with Ctrl+C. Restart the server after backend changes.

Startup checks that the port is available before rebuilding. If an older server is still running, stop it first and start again. The interface checks the API version and gives restart instructions when its server is outdated; this prevents a missing-operation error when a newer interface meets an older backend.

`npm.cmd` avoids PowerShell restrictions on `npm.ps1`. `Start-Look-in-Git.ps1` is an optional convenience launcher if your policy permits local scripts; changing execution policy is unnecessary.

```powershell
npm.cmd run dev   # Vite frontend hot reload; same local Express API
npm.cmd test      # Automated tests against disposable Git repositories
npm.cmd run build # TypeScript checks and production frontend build
npm.cmd run demo  # A disposable fixture, isolated from existing repositories
```

## Electron desktop builds

The same React interface and bundled Express/Git backend can run in a native Electron window. Windows builds include an NSIS installer and portable EXE; macOS builds produce a DMG. The desktop app lets its backend bind an available loopback port, verifies the backend before opening the window, and stops it when the app exits. Startup checks that Git is installed and gives a clear error if it is missing. Git commands still run locally through the existing fixed Git operations and use the user's installed Git credential helper or SSH setup. Git itself must be installed and available on `PATH`; Node.js and npm are bundled/not required on client machines.

The regular `npm.cmd start`, `npm.cmd run dev`, and test/build scripts are unchanged. Desktop development requires network access for the pinned Electron package:

```powershell
npm.cmd run desktop:dev
```

For release packaging, provide the issuer's **public** Ed25519 key at `artifacts/issuer/public.pem` (the private signing key must never be included). Build on the target operating system:

```powershell
npm.cmd run build
npm.cmd run desktop:build:win # Windows installer and portable EXE
npm.cmd run desktop:build:mac # macOS DMG; run on a Mac
```

Desktop packages and icons are generated under `artifacts/desktop` and `artifacts/electron-icons`. The release workflow requires `LOOK_IN_GIT_LICENSE_PUBLIC_KEY` in GitHub Actions secrets. Builds are currently unsigned and are not notarized; a production distribution needs platform signing credentials and a clean-machine install check on each supported OS.

The release workflow builds Windows and macOS assets when a `v*` tag is pushed. Configure `LOOK_IN_GIT_LICENSE_PUBLIC_KEY` as a repository Actions secret containing the public PEM. Release artifacts are unsigned; distribution outside internal testing still needs platform code signing and notarization. The current environment has not produced or smoke-tested the Windows installer, portable executable, or macOS DMG, so these package targets still need a clean-machine install test on Windows and a Mac before client release.

If port 4317 is occupied, stop your previous instance or choose another port:

```powershell
$env:LOOK_IN_GIT_PORT = '4318'
npm.cmd start
```

Optional `LOOK_IN_GIT_DISCOVERY_ROOT` changes the discovery folder. `LOOK_IN_GIT_REPO` opens an absolute repository path first. The server always binds to `127.0.0.1`; these settings cannot expose it to the network.

## Finding and navigating repositories

At startup, the app discovers repositories under **`~/code`** (the `code` folder in your user profile on Windows). Use the top repository selector to switch projects. The sidebar shows **only the active repository**: its working branch, Working Changes, History, Branches, Compare, stashes, and collapsible local/remote branches.

### Company and custom groups (2.1.1)

The compact **group selector** immediately before the repository dropdown filters it to one company or any custom label, such as **Personal**, **Client projects**, or **Open source**. **All groups** shows everything; **Ungrouped** finds projects not yet classified. The sidebar continues to show just one repository.

Open the group selector and choose **Organize repositories…** to create/rename/remove labels and assign repositories. Search finds groups; entering an unknown name offers to create it. The organizer searches repository names, paths, and labels. Opening, cloning, or creating a repository lets you choose a group, defaulting to the current group. Removing a label only makes its repositories Ungrouped. Reclassifying the current repository keeps it open and follows its new group.

Labels and the active group are saved in browser local storage, keyed by repository path rather than temporary server IDs. They survive refreshes and server restarts at the same local address. Different browser profiles/ports have separate preferences; clearing site data removes them. Classification never writes to repositories or changes Git configuration. The command palette also finds groups and repositories across groups.

Use **+** in the top bar to open any local Git working directory by absolute path, including its `.git` directory or a subdirectory. The dialog can also scan a local parent folder, clone a repository, or initialize a new repository. Clone/create require a new folder outside existing repositories; they never overwrite an existing folder. Clone uses the normal Git credential helpers. Repository paths, display preferences, and per-repository commit-message drafts are remembered in browser local storage. Credentials and file contents are not stored there. Successful commits clear their draft.

Discovery is bounded to 3 directory levels, 800 visited folders, and 50 repositories. It skips dependency/build folders and symlinked directories. Repositories deeper in the tree can be opened directly. Bare repositories and network shares are not working-copy views.

The active branch shows **↑ ahead** and **↓ behind** its upstream. These counts reflect local remote-tracking refs; use **Git actions → Fetch** to update them. A branch without an available upstream says **No upstream**. Push and pull default to the configured upstream's actual remote branch, even when its name differs from the local branch. Their review dialogs let you select the destination explicitly. A first push can establish tracking; an explicit push to another destination preserves an existing upstream.

The **File, View, Repository, Working Copy, and Help** menus sit in one narrow row above the repository ribbon. They expose the existing actions plus the new workflows below. Use **Ctrl+K** to find menu actions by name. The View menu controls panels and inline/split diff layout. **File → Preferences** controls theme, diff context (3/10/25/50 lines), diff font size, and toolbar labels. Changing context re-renders the diff; selected-line staging/unstaging/discard uses the same context to verify its fingerprint.

**Preferences → Export preferences** downloads a JSON backup of groups, remembered repository paths, and display settings. **Import preferences** validates the file, shows what will be replaced, then reloads the app. Neither operation moves repository content, commit drafts, credentials, or licenses. Backups contain local paths; treat them as workspace metadata. The existing browser profile remains the live preference store.

Top-bar panel buttons hide/show the sidebar, file tree, and details. **Reset layout** restores them. File selection and expanded folders survive refreshes and panel toggles. Light/dark mode and panel visibility are remembered.

## Working with changes

- **Files and diffs fold independently (2.1.2):** click the chevron beside **FILES** to collapse the whole list, including root-level files. Click a folder row to collapse its children; the toolbar also names its current **Collapse all folders / Expand all folders** action. Focused folders support Left/Right arrows. Click the selected diff's filename/chevron to fold its content. Refresh preserves these states and file selection; folding never changes staging. In History, folding Files gives the commit list more room.
- The folder tree contains changed files only, with each path appearing **once in its original folder**. Staging never moves a file to another section. Each file has a full status label: **New**, **Modified**, **Deleted**, **Renamed**, **Copied**, **Type changed**, or **Conflict**. Added/deleted line totals and binary indicators appear beside it.
- Check a file to run `git add`; uncheck a staged file to remove it from the index while retaining its working contents. **Empty = unstaged, check = fully staged, dash = partially staged.** The caption spells out the state. Check a partial file to stage its remaining changes, or right-click to unstage it. The diff has Staged/Unstaged selectors when both versions exist. Checkbox states come from Git and survive refreshes, including newly added files.
- The compact commit row stays above the file view. Enter a summary, optionally expand **Description**, and commit the staged changes. **Describe** produces an editable, local summary of the staged filenames/statuses/counts; it does not call an AI service.
- Inspect syntax-highlighted inline or side-by-side diffs, with line numbers and independent horizontal scrolling in split view. Long diffs use windowed rendering.
- Drag a file onto the tree header's Stage/Unstage buttons to stage/unstage it. Right-click files for staging, explicit move/rename, and discard actions. Drag a branch onto the working branch to open a merge action.
- Click a branch to inspect its latest commit. Double-click a different local branch to open Switch branch. **Double-click a remote branch to fetch its latest commits, stash your current staged/unstaged/untracked changes, and switch to its local tracking branch.** Look-in-Git creates that local branch when needed, or fast-forwards an existing one. It then asks whether to reapply the exact saved stash with its staged state preserved, or keep it saved. It never pulls those commits into the branch you are leaving. Local-only commits are retained; divergence or a different existing upstream stops the switch with an explanation. A fetch failure leaves your working files alone; a later switch failure still offers the saved stash for recovery.
- Right-click branches or commits for contextual actions. Clicking a stash opens a preview of its staged, unstaged, and untracked files; Apply and Pop are explicit actions. Preview/actions remain attached to the stash's immutable object ID even if another stash changes its list position. Remote branch actions use the full Git ref so a similarly named local branch cannot be selected accidentally.
- A local branch marked **WT** is checked out in another worktree. Switching offers **Open existing worktree** with its path. Opening it selects that working directory in the top ribbon; both worktrees retain their files and staging. The API checks occupancy before fetching or stashing for a switch, including remote branches with an existing local checkout. Git disallows the same branch in two worktrees by default; see the [Git worktree documentation](https://git-scm.com/docs/git-worktree). Look-in-Git does not force this restriction off or prune worktrees.

### Selected lines

Click or drag diff lines to highlight changes. **Shift-click** extends a range; **Ctrl-click** (Cmd-click on macOS) adds separate lines. Context lines can bound a range, but only added/removed lines are changed. You can also right-click a line for selected-line actions.

**Stage lines** applies only the selected changes to the index. **Unstage lines** removes only the selected staged changes from the index. The working file stays intact for both actions. To stage a complete replacement, select its removed line(s) and added line(s).

**Discard lines…** presents a warning before it changes the working file. It removes selected additions and restores selected deletions. Other changes stay intact. Discarded uncommitted edits cannot generally be restored by an opposite Git command.

Line operations use server-generated `git apply` patches over stdin. Requests contain line indexes and a diff fingerprint, never a client-supplied patch. A changed fingerprint rejects a stale selection. Binary, non-UTF-8, truncated, renamed/copied, and mode-only changes use file-level operations. New and deleted regular text files support partial line operations.

## Git actions and credentials

The **Git actions** dropdown in the top bar provides stage/unstage all, commit, fetch, pull, push, stash save/apply/pop, merge, rebase, branch creation/switching, and credentials. Context menus add file move/discard, safe branch deletion, cherry-pick, and revert. Operation results show the Git command and output. Errors keep the current repository available for inspection.

### Desktop-menu workflows (2.2.0)

Every action in this section opens a review showing the exact branch or files and a short explanation. A fingerprint rejects a stale review when Git state, relevant configuration, or the request changes. The server rejects unknown workflow arguments; it invokes fixed Git operations with `execFile` and no shell.

- **Working Copy → Create snapshot** uses Git's stash-create/store flow to save *tracked* staged and unstaged edits under a name without cleaning the working copy. New/ignored files are excluded; use **Save stash** with untracked files for those.
- **Working Copy → Discard all local changes** first saves staged, unstaged, and untracked changes in a named recovery stash. The resulting working copy is clean, while ignored files remain. Reapply the stash from the sidebar to recover. This requires an existing commit; the initial unborn branch cannot use stash.
- **Reset to revision** offers soft (keep index and files) and mixed (keep files, replace index) modes. It creates a recovery branch at the old commit before moving the branch. Hard reset is not offered. **Amend latest commit** similarly preserves the old commit on a recovery branch before replacing its message and incorporating staged changes. Neither publishes rewritten history.
- **Checkout revision** optionally saves staged/unstaged/untracked edits in a stash, then uses detached HEAD at the selected commit. The original branch stays at its old tip. Switch back to a branch and explicitly reapply the stash when ready. If checkout fails, the saved stash remains available.
- **Apply patch** accepts a Git patch of regular files up to 1 MiB. Git parses changed paths and verifies all hunks before a single worktree-only apply. Traversal, Git metadata paths, symlinks, and submodule changes are rejected. **Export patch** downloads staged, unstaged, or two-revision changes, including binary patches, up to 1 MiB. Stage untracked files first to include them.
- **Worktrees** in the repository sidebar lists the main worktree and all linked worktrees with branch, commit, clean/dirty, detached, locked, and missing-folder state. Select a row to open its independent status, staging area, diffs, and history. Branches checked out elsewhere are marked and cannot be checked out twice.
- Create a worktree from a new branch and base revision or an available local branch. Compare a linked branch with the active one, assign a local Codex/agent label, move or lock/unlock linked worktrees, and remove a clean worktree while keeping its branch by default. Deleting a branch is a separate opt-in and succeeds only when Git reports it merged. Repair and prune require explicit confirmation; pruning removes stale metadata only. No operation force-removes or silently discards worktree changes.
- **Fetch all remotes** contacts each configured remote sequentially. **Sync with upstream** requires a clean working copy and a valid upstream, then fetches that remote, fast-forwards the local branch, and pushes to the same upstream. Diverged histories stop before push. These network actions use the same Git credential helper or SSH setup as other actions; they do not force-push. **Publish tag** pushes only the selected local tag to one configured remote.

**File → Open in Explorer / Open in PowerShell** launches the desktop program at the revalidated repository root. The terminal is interactive and receives no app-supplied Git or shell commands. **Help** has an in-app guide and release notes. Its diagnostic report is a local JSON download with app/runtime versions, counts, and operation names/status/timings; it excludes paths, file content, remote addresses, command arguments/output, and credentials. Updates are currently delivered as new client ZIPs, with no automatic update service.

**Merge branches, Push commits, Pull updates, and Squash merge** open an action preview before running. It names the source and destination branches, shows the remote address when relevant, and explains the effect and next step. Incoming/outgoing counts for remotes use locally cached refs and are labeled accordingly; opening a preview does not contact the remote. Push and pull use the reviewed destination, defaulting to the configured upstream. Push excludes uncommitted files. The final button names the destination, such as **Push to origin/main** or **Merge into main**. Changes to the reviewed branch, commit, upstream configuration, remote URLs, or file status require a refreshed review.

**Squash merge** combines another branch's changes into the current branch's staging area, then stops. Start with a clean working copy, review the result, and use the commit row to create one new commit. The source branch and existing history stay unchanged; this action does not rewrite a sequence of existing commits. Conflicts use the embedded editor. A squash does not create a normal merge-in-progress state, so it has no **Abort merge** action. Review the resulting files before using discard operations.

Pull uses **fast-forward only**. Push does not force. Branch deletion uses `git branch -d`. There is no arbitrary shell-command endpoint, hard reset, force push, or clean command. Git hooks, fsmonitor programs, and commit/tag signing are disabled for app actions. Explicit write actions retain normal Git content filters and identity configuration. If your project requires hooks or signed commits, use its normal command-line workflow for those operations.

Set a Git author identity before committing if you have not already done so:

```powershell
git config --global user.name 'Your Name'
git config --global user.email 'you@example.com'
```

Use **Remotes & tracking** in the sidebar to add, edit, or remove local remote configuration, rename a local branch, or set its upstream. URL edits/removal check that the reviewed configuration is still current. Removing a remote configuration does not delete a hosted repository. **Tags** creates lightweight or annotated local tags, inspects their commits, and deletes an explicitly reviewed local tag. Tag deletion rejects a changed tag. Tags are not automatically pushed. Look-in-Git does not invent or contact a remote on startup.

## History, recovery, and daily navigation

Click any local or remote branch name in the sidebar or **Branches** view to browse its history. The Branches view also has an explicit **History** button. The current branch's entry in Local Branches opens its commits too; the separate Working Branch/Working Changes controls return to your edits. The **Browse** selector chooses local branches, remote branches, or all branches and tags. A compact caption identifies both the history being viewed and the branch actually checked out. These inspection controls never checkout, fetch, stash, or alter files. Double-clicking a different sidebar branch retains its explicit switch workflow. Remote history reflects the last fetch.

History searches commit subjects/bodies and hashes, with branch, author, and file-path filters. Search text is literal. File history follows renames. Select a commit to see its full message, author/committer, parents, refs, and changed-file tree; copy its full hash from the details pane. Right-click a file for **File history**. Compare accepts arbitrary commits, branches, or tags.

**Reflog & recovery** lists local HEAD movements. Inspect an entry or create a recovery branch at its commit. Recovery creates a reference without moving the current branch or altering working files. It cannot recover edits that were never committed or stashed.

The top-bar activity button opens the operation journal: command arguments, redacted output, status, and duration. It retains the latest 100 completed actions plus in-progress operations in server memory, scoped by repository. Restarting clears the journal. Credential contents are excluded; URLs are redacted. Git commit messages and paths may appear in this local journal.

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` or `Ctrl+Shift+P` | Find commands, branches, and repositories |
| `Ctrl+Shift+O` | Open a local repository |
| `Ctrl+,` | Preferences |
| `Alt+1` through `Alt+4` | Working Changes, History, Branches, Compare |
| `F5` | Refresh the repository |
| `Ctrl+Enter` in the commit composer | Commit staged changes |

Returning to the app refreshes local Git state when no action/dialog is active. This never fetches from a remote. Branch search in the command palette inspects history without switching branches.

### HTTPS

Fetch, pull, and push use the **same configured Git credential helpers as your command-line Git**, including URL-specific helpers. Existing saved credentials work without entering them into Look-in-Git. The app does not replace your helper or change global Git settings.

The Git credentials dialog shows the selected remote and whether a helper is configured. To supply a token manually, select an HTTPS remote and enter your hosting username and token. The app passes them to `git credential approve` over stdin; your configured helper controls storage and retention. No token is stored in project files, browser storage, API responses, or command arguments.

The app cannot answer terminal prompts. If a helper requires initial browser login or a new SSH trust prompt, complete that using your normal Git command-line workflow first, then retry. Tokens still need the hosting provider's required permissions and must not be expired. Tests verify helper handoff without accessing or saving real user credentials.

### SSH

SSH remotes use your existing keys, SSH agent, Git SSH configuration, and any configured `GIT_SSH`, `GIT_SSH_COMMAND`, or `GIT_SSH_VARIANT`. Unlock keys and establish trusted hosts through your normal SSH workflow. Look-in-Git has no separate SSH credential store or .NET dependency.

## Embedded merge tool

A conflicted text file opens a three-way editor with **Ours**, **Theirs**, optional **Base**, and an editable **Merged result**. Choose a whole-file version, accept conflict blocks from either/both sides, or edit the result. During a rebase, Ours/Theirs reflect Git's index stages, whose meanings differ from a normal merge.

**Save draft** writes the result without resolving the index. **Save & stage** writes and stages a result with no remaining conflict markers. Complete a merge with the commit row, or use the in-progress banner to **Continue** a rebase/cherry-pick/revert. The banner also offers Abort. File and index fingerprints reject stale editor saves.

The embedded merge editor supports regular UTF-8 text files up to 1 MiB. Binary, deleted-file, symlink, and non-UTF-8 conflicts require a suitable external Git tool. Saving a result is explicit; selecting a source does not write anything.

## Local boundary and limits

All Git execution uses `child_process.execFile` with `shell: false`, fixed operation names, and constructed argument arrays. No user-supplied shell commands run. Repository roots/Git directories are pinned and revalidated on every repository API request. File endpoints reject traversal, metadata paths, symlinks, junctions, and paths escaping the repository. Filenames are passed as literal pathspecs; porcelain v1 NUL parsing preserves unusual names and rename source/destination order.

The server checks Host, browser Origin, fetch metadata, and a random per-process request token. There is no CORS wildcard. The token is a local request boundary, not a login system. The app is intended for your own local desktop, not hosting behind a public proxy or treating hostile local processes as trusted.

Write operations are serialized by the repository's canonical common Git directory, including linked worktrees. File discard requires a fresh content/index fingerprint and rejects changes made since review; the reviewed file limit is 1 MiB. This detects stale actions but cannot make discarded uncommitted edits recoverable.

Diff previews are limited to 1 MiB / 12,000 lines, with an explicit notice. Binary files have a dedicated state. Git calls have output, concurrency, and timeout limits. History loads 50 commits at a time; the stash list shows the latest 100. Submodule internals are not traversed. Read-only views disable external diffs, textconv, clean/process filters, and optional index locks. Background refresh never fetches, pulls, pushes, or commits; invoking remote checkout explicitly fetches the selected branch.

## Validation and project structure

`npm.cmd test` creates disposable repositories below `artifacts/fixtures/look-in-git-*` or dedicated system temporary directories. Tests cover NUL parsing, unusual filenames, renames, read-only snapshots, API origins/tokens/path boundaries, unborn/detached repositories, binary/large files, real staging/commits/stashes, local bare-remote push/fetch/pull, ahead/behind counts, merge/rebase resolution, line patches, and credential handoff. Credential tests verify configured-helper handoff with a mock and an authenticated loopback HTTP fixture; they never access the user credential store or save a real token. No existing repository or real remote is changed by tests. Automated fixture cleanup verifies each absolute target before deletion. Demo fixtures remain available for inspection.

Remote checkout tests cover fresh fetches, local tracking branch creation and fast-forwarding, preserved index/untracked changes, local-only commits, divergence, conflicting upstreams, failed fetches, occupied-worktree checks before fetch/stash, and ambiguous local/remote branch names. API compatibility tests cover outdated servers and occupied-port startup.

Additional suites exercise differing upstream names, worktree porcelain parsing and lifecycle actions, linked-worktree locking, stale discard rejection, literal history filters, reflog recovery, stash snapshots, remote/tag races, clone/init boundaries, journal retention/redaction, trial expiry, signed activation, API bypass attempts, packaging manifests, and Windows launchers. The 2.2 workflow suite uses disposable Git fixtures to test snapshots, recovery stash, reset/amend recovery refs, worktree creation, patch safety, fetch-all, tag publishing, sync, checkout, and private diagnostics.

## Build a client release

The developer checkout runs without a trial. Distribute the generated client ZIP, not this source directory. Client bundles embed the issuer's public key and enforce the 30-day trial in the API; command-line development flags do not disable it.

```powershell
# First issuer setup only; refuses to overwrite keys.
npm.cmd run license:init

# Build and package a client release.
npm.cmd run package:client
```

Issuer keys have already been initialized for this workspace in `artifacts/issuer/`. **Back up `private.pem` securely and keep it on the issuer machine. Never send it to clients.** Preserve the same issuer key across releases so existing paid licenses remain valid. Only `public.pem` is embedded in a client bundle. The entire `artifacts/` directory is ignored by Git.

The packager creates a uniquely named ZIP and SHA-256 checksum under `artifacts/releases/`. It contains the prebuilt UI, bundled Node backend, `Start-Look-in-Git.cmd`, a PowerShell launcher, QuickStart, file manifest, and third-party license notices. It excludes source, tests, fixtures, issuer keys, and development dependencies. Clients extract the entire ZIP and double-click `Start-Look-in-Git.cmd`; the browser opens when ready. **Clients need Git for Windows and Node.js 22.12+ on PATH, but do not need npm install or a build.** Keep the launcher window open; Ctrl+C stops the app. Upgrades extract to a new folder after stopping the old copy.

Optionally include a Windows Node runtime with its complete matching upstream license:

```powershell
npm.cmd run package:client -- --node-runtime 'C:\release-tools\node.exe' --node-license 'C:\release-tools\LICENSE'
```

Git remains a separately installed prerequisite so the app uses the client's normal Git/credential environment. ZIP checksums detect changes; they are not a code signature. This release does not include a signed installer or automatic updates.

## Trial and paid activation

The **30-day trial** starts on the first client launch. State is stored outside the application folder at `%LOCALAPPDATA%\Look-in-Git\license-state.json`, so normal upgrades and restarts retain it. The app shows remaining days and exposes **License & activation** through the command palette/footer. At expiry, Git API access is blocked and the activation dialog remains available. No repository is deleted, modified, or encrypted because of expiry.

After arranging payment separately, issue a signed license on your issuer machine:

```powershell
# Perpetual license; use --device with the ID displayed in the client's app
# to restrict the license to that device.
npm.cmd run license:issue -- --key artifacts/issuer/private.pem --customer 'Client Name' --device 'DEVICE_ID_FROM_CLIENT' --out artifacts/licenses/client.lic

# Or issue an expiring license (365 days from issuance).
npm.cmd run license:issue -- --key artifacts/issuer/private.pem --customer 'Client Name' --days 365 --out artifacts/licenses/client-year.lic
```

Send only the resulting `.lic` file to that customer. They paste its contents into **License & activation**. Omitting `--device` permits the license on other computers; omitting `--days` makes it perpetual. Signing uses Ed25519; the client checks signature, product, optional device, issuance, and expiry. Invalid keys, damaged state, and a clock rollback exceeding five minutes fail closed.

This is offline licensing, with no payment processor, online activation, or remote revocation. It deters casual sharing; a determined local administrator can patch distributed JavaScript or remove/reset local trial state. Stronger enforcement requires a separate activation service or platform protection and a revised offline policy. Technical licensing does not establish contractual ownership terms; `NOTICE.txt` is a copyright notice, not an EULA.

## Product audit and remaining scope

The enterprise workflow audit used primary product references: [Tower history search](https://www.git-tower.com/help/guides/commit-history/search-commits/windows), [stash inspection](https://www.git-tower.com/help/guides/working-copy/stash/windows), [reflog](https://www.git-tower.com/help/guides/commit-history/reflog/windows), [Fork](https://fork.dev/), [Sourcetree](https://www.sourcetreeapp.com/), and [GitKraken's interface guide](https://help.gitkraken.com/gitkraken-desktop/interface/). The changes above focus on everyday navigation, explicit action destinations, and recovery visibility.

This is a tested release candidate, not a claim of feature parity with every established client. LFS/submodule management, blame, interactive rebase editing, signed installers/notarization, and online license revocation remain future work. Existing Git hooks and signing remain disabled as described above; teams requiring them should retain their normal CLI workflow.

| Folder | Purpose |
| --- | --- |
| `src/` | React UI, diff rendering, styles |
| `server/` | Express boundary, Git services, credentials, merge and line actions |
| `shared/` | API types |
| `scripts/` | Startup and disposable fixture helpers |
| `tests/` | Git parsing and API integration tests |

The layout takes cues from [Tower's working-copy workflow](https://www.git-tower.com/help/guides/first-steps/basic-workflow/windows). Colors use Microsoft's [VS Code Dark Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json), [Light Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/light_modern.json), and [Dark+ syntax palette](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_plus.json) as references. Git behavior follows the official [status](https://git-scm.com/docs/git-status), [apply](https://git-scm.com/docs/git-apply), and [credential](https://git-scm.com/docs/git-credential) documentation.
#   l o o k - i n - g i t  
 