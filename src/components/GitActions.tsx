import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Archive, Check, ChevronDown, CircleCheck, GitCommitHorizontal, LoaderCircle, Terminal, Undo2, X } from 'lucide-react';
import type { ActionKind, ActionOptions, ActionRequest, ActionResult, ActionReview, DiscardReview, Branch, ChangedFile, Commit, Repository, Stash } from '../../shared/types';
import { branchRef, branchLabel, otherWorktree } from '../../shared/branches';
import { api, query, ApiRequestError } from '../api';
import { ActionReviewPanel } from './ActionReviewPanel';
import { Credentials } from './Credentials';

export const actionLabels: Record<ActionKind, string> = {
  stage: 'Stage file', unstage: 'Unstage file', 'stage-all': 'Stage all changes', 'unstage-all': 'Unstage all', commit: 'Commit', 'stash-save': 'Save stash', 'stash-apply': 'Apply stash', 'stash-pop': 'Pop stash', fetch: 'Fetch', pull: 'Pull updates', push: 'Push commits', merge: 'Merge branches', squash: 'Squash merge', rebase: 'Rebase', switch: 'Switch branch', 'branch-create': 'New branch', 'branch-recover': 'Create recovery branch', 'branch-delete': 'Delete branch', rename: 'Move / rename file', discard: 'Discard unstaged changes', 'cherry-pick': 'Cherry-pick commit', revert: 'Revert commit', 'merge-abort': 'Abort merge', 'rebase-abort': 'Abort rebase', 'cherry-pick-abort': 'Abort cherry-pick', 'revert-abort': 'Abort revert', 'rebase-continue': 'Continue rebase', 'cherry-pick-continue': 'Continue cherry-pick', 'revert-continue': 'Continue revert',
};
const descriptions: Partial<Record<ActionKind, string>> = {
  commit: 'Commit the changes currently in the staging area.',
  'stash-save': 'Save local changes and clear the working copy. Give this stash a name you will recognize.',
  'stash-apply': 'Restore a saved stash, including its staged state. The stash stays in the list.',
  'stash-pop': 'Restore a saved stash and remove it after a successful apply.',
  fetch: 'Download updated refs and objects from a configured remote.',
  pull: 'Bring remote commits into your current local branch. Review the download source and the branch that will change.',
  push: 'Publish your local commits. Review the remote destination before sending them.',
  merge: 'Bring another branch into the branch you currently have checked out.',
  squash: 'Combine another branch’s changes for one new commit. Review and commit the result afterward.',
  rebase: 'Replay the current branch on top of the selected branch or commit.',
  switch: 'Switch to a local branch or create a local tracking branch from a remote branch.',
  'branch-create': 'Create a branch and switch to it.',
  'branch-recover': 'Create a new branch at this saved commit. Your current branch and working files stay in place.',
  'branch-delete': 'Delete a merged local branch. Git will refuse to delete an unmerged or checked-out branch.',
  rename: 'Move a tracked file with git mv. Use a path relative to the repository root.',
  discard: 'Replace this file’s unstaged contents with its index version. Uncommitted edits discarded this way are not recoverable with an opposite Git command.',
  'cherry-pick': 'Apply this commit as a new commit on the current branch.',
  revert: 'Create a new commit that reverses the selected commit.',
};
interface MenuItem { label: string; action: () => void; disabled?: boolean; danger?: boolean; separator?: boolean }
interface Modal { action: ActionKind; seed?: Partial<ActionRequest> }

export function useGitOperations(repo: Repository | undefined, onChanged: (repoId?: string) => void, onError: (message: string) => void, onSwitched?: (repoId: string) => void, onFileHistory?: (path: string) => void, onOpenRepository?: (repo: Repository) => void) {
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [activity, setActivity] = useState<{ title: string; result: ActionResult; error?: boolean } | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [savedSwitchStash, setSavedSwitchStash] = useState<{ repoId: string; stash: Stash } | null>(null);
  const [worktreeRecovery, setWorktreeRecovery] = useState<{path:string;branch:string}|null>(null);
  const running = useRef(false);
  const currentRepo = useRef(repo); currentRepo.current = repo;
  useEffect(() => { setMenu(null); setModal(null); setActivity(null); setCredentialsOpen(false); setWorktreeRecovery(null); }, [repo?.id]);
  async function openWorktree(path:string) {
    if(running.current || !onOpenRepository)return;
    running.current=true;setBusy(true);
    try { const opened=await api<Repository>('/repositories',{method:'POST',body:JSON.stringify({path})});setModal(null);setWorktreeRecovery(null);onOpenRepository(opened); }
    catch(e) { const message=(e as Error).message;onError(message);setActivity({title:'Open worktree needs attention',result:{command:[],output:message},error:true}); }
    finally {running.current=false;setBusy(false);}
  }
  async function runAction(body: ActionRequest) {
    const targetRepo = currentRepo.current;
    if (!targetRepo || running.current) return false;
    running.current = true;
    setBusy(true); setMenu(null); setActivity(null);
    try {
      const result = await api<ActionResult>(`/repositories/${targetRepo.id}/actions`, { method: 'POST', body: JSON.stringify(body) });
      if (currentRepo.current?.id === targetRepo.id) setActivity({ title: result.switchedBranch ? `Switched to ${result.switchedBranch}` : result.summary ?? `${actionLabels[body.action]} · ${targetRepo.name}`, result });
      if (result.stashed) setSavedSwitchStash({ repoId: targetRepo.id, stash: result.stashed });
      if (['stash-apply', 'stash-pop'].includes(body.action) && body.stashHash === savedSwitchStash?.stash.hash) setSavedSwitchStash(null);
      if (currentRepo.current?.id === targetRepo.id) setModal(null);
      if (result.switchedBranch) onSwitched?.(targetRepo.id);
      return true;
    } catch (e) {
      if (e instanceof ApiRequestError && e.recovery?.stashed) setSavedSwitchStash({ repoId: targetRepo.id, stash: e.recovery.stashed });
      if (e instanceof ApiRequestError && e.recovery?.worktree && currentRepo.current?.id === targetRepo.id) { setWorktreeRecovery(e.recovery.worktree);setModal({action:'switch',seed:body}); }
      const message = (e as Error).message;
      if (currentRepo.current?.id === targetRepo.id) setActivity({ title: `${actionLabels[body.action]} needs attention`, result: { command: [], output: message }, error: true });
      if (currentRepo.current?.id === targetRepo.id) onError(message);
      return false;
    } finally { running.current = false; setBusy(false); onChanged(targetRepo.id); }
  }
  function openAction(action: ActionKind, seed?: Partial<ActionRequest>) {
    setMenu(null); setWorktreeRecovery(null);
    if (['stage', 'unstage', 'stage-all', 'unstage-all'].includes(action) || (action.endsWith('-abort') || action.endsWith('-continue'))) void runAction({ ...seed, action });
    else { setActivity(null); setModal({ action, seed }); }
  }
  function contextMenu(event: MouseEvent, context?: { file?: ChangedFile; stagedFile?: ChangedFile; branch?: Branch; commit?: Commit; stash?: Stash }) {
    if (!currentRepo.current) return;
    event.preventDefault(); event.stopPropagation();
    const items: MenuItem[] = [];
    const item = (action: ActionKind, seed?: Partial<ActionRequest>, disabled = false, separator = false) => ({ label: actionLabels[action], action: () => openAction(action, seed), disabled: disabled || busy, separator, danger: action === 'discard' || action === 'branch-delete' });
    const file = context?.file, branch = context?.branch, commit = context?.commit;
    if (context?.stash) items.push(item('stash-apply', { stash: context.stash.ref, stashHash: context.stash.hash }), item('stash-pop', { stash: context.stash.ref, stashHash: context.stash.hash }));
    if (file && ['staged', 'unstaged', 'untracked'].includes(file.scope)) {
      items.push(item(file.scope === 'staged' ? 'unstage' : 'stage', { path: file.path }));
      if (file.scope !== 'staged' && context?.stagedFile) items.push(item('unstage', { path: file.path }));
      items.push(item('rename', { path: file.path, target: file.path }, file.scope === 'untracked' || file.status === 'D'));
      if (file.scope === 'unstaged' && !file.conflict) items.push(item('discard', { path: file.path }));
    }
    if (file && onFileHistory) items.push({ label: 'File history', action: () => { setMenu(null); onFileHistory(file.path); } });
    if (branch) {
      items.push({...item('switch', { target: branchRef(branch) }, branch.current),label:otherWorktree(branch,currentRepo.current.root)?'Open existing worktree…':actionLabels.switch});
      items.push({ ...item('merge', { target: branchRef(branch) }, branch.current), label: `Merge ${branch.name} into current branch` });
      items.push({ ...item('squash', { target: branchRef(branch) }, branch.current), label: `Squash ${branch.name} into current branch` });
      items.push(item('rebase', { target: branchRef(branch) }, branch.current));
      items.push(item('branch-delete', { target: branch.name }, branch.current || branch.remote));
    }
    if (commit) {
      items.push(item('cherry-pick', { target: commit.hash })); items.push(item('revert', { target: commit.hash }));
      items.push(item('branch-create', { message: commit.hash }));
    }
    items.push(item('stage-all', undefined, false, items.length > 0), item('unstage-all'), item('commit'));
    items.push(item('fetch', undefined, false, true), item('pull'), item('push'));
    items.push(item('stash-save', undefined, false, true), item('stash-apply'), item('stash-pop'));
    items.push(item('merge', undefined, false, true), item('squash'), item('rebase'), item('switch'), item('branch-create'));
    items.push({ label: 'Git credentials…', action: () => { setMenu(null); setCredentialsOpen(true); }, separator: true });
    items.push({ label: 'Refresh', action: () => { setMenu(null); onChanged(); }, separator: true });
    setMenu({ x: event.clientX, y: event.clientY, items });
  }
  const toolbar = <button className="button git-actions-dropdown" aria-haspopup="menu" aria-label="Git actions" disabled={!repo || busy} onClick={event => contextMenu(event)} onContextMenu={event => contextMenu(event)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Terminal size={15} />}<span>{busy ? 'Running Git…' : 'Git actions'}</span><ChevronDown size={12} /></button>;
  const overlays = <>
    {savedSwitchStash && savedSwitchStash.repoId === repo?.id && <div className="stash-switch-notice" role="status"><Archive size={16} /><span>Reapply your saved changes to the current branch?</span><button disabled={busy} onClick={() => openAction('stash-apply', { stashHash: savedSwitchStash.stash.hash })}>Reapply stash…</button><button disabled={busy} onClick={() => setSavedSwitchStash(null)}>Keep saved</button></div>}
    {credentialsOpen && repo && <Credentials repo={repo} onClose={() => setCredentialsOpen(false)} />}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    {modal && repo && <ActionDialog worktreeRecovery={worktreeRecovery} onOpenWorktree={openWorktree} repo={repo} action={modal.action} seed={modal.seed} busy={busy} failureMessage={activity?.error ? activity.result.output : ''} run={runAction} onClose={() => { if (!busy) setModal(null); }} />}
    {activity && <div className={`operation-toast ${activity.error ? 'operation-error' : ''}`} role="status"><button onClick={() => setShowOutput(!showOutput)}>{activity.error ? <Undo2 size={16} /> : <CircleCheck size={16} />}<span>{activity.title}</span><ChevronDown size={13} /></button><button className="icon-button" onClick={() => setActivity(null)} aria-label="Dismiss operation result"><X size={14} /></button>{showOutput && <pre>{activity.result.summary ? activity.result.summary + '\n\n' : ''}{(activity.result.commands ?? [activity.result.command]).map(command => command.join(' ')).join('\n')}{'\n'}{activity.result.output}</pre>}</div>}
  </>;
  return { toolbar, overlays, busy, runAction, openAction, contextMenu, openCredentials:()=>setCredentialsOpen(true) };
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useEffect(() => {
    const menu = menuRef.current!;
    const rect = menu.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
    menu.focus();
    const close = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', onClose); };
  }, [x, y]);
  return <div className="context-menu" role="menu" aria-label="Git actions" tabIndex={-1} ref={menuRef} style={{ left: position.x, top: position.y }} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const buttons = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>{items.map((item, index) => <button role="menuitem" key={`${item.label}:${index}`} disabled={item.disabled} className={`${item.separator ? 'menu-separator' : ''} ${item.danger ? 'danger-text' : ''}`} onClick={item.action}>{item.label}</button>)}</div>;
}

function ActionDialog({ worktreeRecovery, onOpenWorktree, repo, action, seed, busy, failureMessage, run, onClose }: { worktreeRecovery:{path:string;branch:string}|null; onOpenWorktree:(path:string)=>Promise<void>; repo: Repository; action: ActionKind; seed?: Partial<ActionRequest>; busy: boolean; failureMessage: string; run: (body: ActionRequest) => Promise<boolean>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ActionOptions | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(seed?.message ?? '');
  const [target, setTarget] = useState(seed?.target ?? '');
  const [remote, setRemote] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [discard, setDiscard] = useState<DiscardReview | null>(null);
  const [stash, setStash] = useState(seed?.stash ?? '');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [stashBeforeSwitch, setStashBeforeSwitch] = useState(true);
  const [reviewResult, setReviewResult] = useState<{ key: string; data: ActionReview } | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewVersion, setReviewVersion] = useState(0);
  const needsReview = ['merge', 'squash', 'push', 'pull'].includes(action);
  const reviewReady = !!options && (action === 'push' || action === 'pull' ? !!remote : !!target.trim());
  const reviewKey = JSON.stringify([repo.id, action, target, remote, remoteBranch, reviewVersion]);
  const review = reviewResult?.key === reviewKey ? reviewResult.data : null;
  useEffect(() => {
    setReviewError('');
    if (!needsReview || !reviewReady) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<ActionReview>(`/repositories/${repo.id}/action-review?${query({ action, ...(action === 'push' || action === 'pull' ? { remote, ...(remoteBranch ? {remoteBranch} : {}) } : { target }) })}`, { signal: controller.signal })
        .then(data => { if (!controller.signal.aborted) setReviewResult({ key: reviewKey, data }); })
        .catch(error => { if (!controller.signal.aborted) setReviewError(error.message); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [needsReview, reviewReady, reviewKey, repo.id, action, remote, remoteBranch, target]);
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    api<ActionOptions>(`/repositories/${repo.id}/action-options`, { signal: controller.signal }).then(result => { setOptions(result); setRemote(result.upstream && result.remotes.includes(result.upstream.remote) ? result.upstream.remote : result.remotes.includes('origin') ? 'origin' : result.remotes[0] ?? ''); setStash(seed?.stashHash ? result.stashes.find(stash => stash.hash === seed.stashHash)?.ref ?? '' : seed?.stash ?? result.stashes[0]?.ref ?? ''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [repo.id]);
  useEffect(() => { if (options && remote) setRemoteBranch(options.upstream?.remote === remote ? options.upstream.branch : options.branch); }, [options, remote]);
  useEffect(() => {
    if (action !== 'discard' || !seed?.path) return;
    const controller = new AbortController(); setDiscard(null);
    api<DiscardReview>(`/repositories/${repo.id}/discard-review?${query({path:seed.path})}`, {signal:controller.signal}).then(setDiscard).catch(e => {if(!controller.signal.aborted)setError(e.message);});
    return () => controller.abort();
  }, [repo.id, action, seed?.path, reviewVersion]);
  const selectedSwitch = action === 'switch' ? options?.branches.find(branch => branchRef(branch) === target || branch.name === target) : undefined;
  const remoteSwitch = !!selectedSwitch?.remote;
  const remoteName = remoteSwitch ? [...(options?.remotes ?? [])].sort((a, b) => b.length - a.length).find(remote => selectedSwitch!.name.startsWith(remote + '/')) : undefined;
  const localSwitchName = remoteName ? selectedSwitch!.name.slice(remoteName.length + 1) : branchLabel(target);
  const occupiedBranch = remoteSwitch ? options?.branches.find(branch=>!branch.remote && branch.name===localSwitchName) : selectedSwitch;
  const occupiedPath = action==='switch' ? otherWorktree(occupiedBranch,repo.root) ?? (worktreeRecovery?.branch===localSwitchName ? worktreeRecovery.path : undefined) : undefined;
  const isRemote = ['push', 'pull', 'fetch'].includes(action);
  const isStashApply = ['stash-apply', 'stash-pop'].includes(action);
  const hasTarget = ['merge', 'squash', 'rebase', 'switch', 'branch-create', 'branch-recover', 'branch-delete', 'rename', 'cherry-pick', 'revert'].includes(action);
  const isMessage = action === 'commit' || action === 'stash-save';
  const hasAbort = options && ((action === 'merge' && options.mergeInProgress) || (action === 'rebase' && options.rebaseInProgress) || (action === 'cherry-pick' && options.cherryPickInProgress) || (action === 'revert' && options.revertInProgress));
  return <dialog className={`open-dialog action-dialog ${needsReview ? 'review-action-dialog' : ''}`} ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else onClose(); }} aria-labelledby="action-title">
    <div className="dialog-heading"><div className="dialog-icon"><GitCommitHorizontal size={24} /></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close Git action"><X size={19} /></button></div>
    <div className="action-repo">{repo.name}<span>/</span>{review ? review.branch || 'Detached HEAD' : options ? options.branch || 'Detached HEAD' : 'Reading branch...'}{review?.head && <code>{review.head.slice(0, 8)}</code>}</div><h2 id="action-title">{actionLabels[action]}</h2><p>{occupiedPath ? 'Git keeps each checked-out branch in its own working directory.' : remoteSwitch ? `Fetch ${selectedSwitch!.name}, save your local changes in a stash, then switch to local ${localSwitchName}. You choose whether to reapply the stash afterward.` : descriptions[action]}</p>
    <form onSubmit={async e => { e.preventDefault(); if (occupiedPath) { await onOpenWorktree(occupiedPath); return; } if (needsReview && (!review || review.blocked)) return; setError(''); const success = await run({ action, ...seed, ...(review ? { reviewFingerprint: review.fingerprint } : {}), ...(isMessage || action === 'branch-create' || action === 'branch-recover' ? { message } : {}), ...(hasTarget ? { target } : {}), ...(isRemote ? { remote, ...(action !== 'fetch' && remoteBranch ? {remoteBranch} : {}) } : {}), ...(discard ? {discardFingerprint:discard.fingerprint} : {}), ...(isStashApply ? { stash, stashHash: options?.stashes.find(item => item.ref === stash)?.hash } : {}), ...(action === 'stash-save' ? { includeUntracked } : {}), ...(action === 'switch' ? { stashBeforeSwitch: remoteSwitch || stashBeforeSwitch } : {}) }); if (!success) { setError('Git could not complete this action. See the operation result for details.'); if (needsReview || action === 'discard') setReviewVersion(version => version + 1); } }}>
      <fieldset className="action-fields" disabled={busy}>
      {seed?.path && <div className="action-file"><code>{seed.path}</code></div>}
      {(action === 'branch-create' || action === 'branch-recover') && <div className="action-file">Starting commit: <code>{message || 'HEAD (current commit)'}</code></div>}
      {action === 'discard' && discard && <div className="action-warning">Discard the reviewed unstaged version of {discard.path}. Staged changes stay. Newer edits will require another review.</div>}
      {isMessage && <><label htmlFor="action-message">{action === 'commit' ? 'Commit message' : 'Stash message'}</label><textarea autoFocus id="action-message" rows={action === 'commit' ? 4 : 2} value={message} onChange={e => setMessage(e.target.value)} placeholder={action === 'commit' ? 'Describe your changes…' : 'What are you working on?'} required={action === 'commit'} maxLength={action === 'commit' ? 10000 : 1000} /></>}
      {action === 'stash-save' && <label className="checkbox-label"><input type="checkbox" checked={includeUntracked} onChange={e => setIncludeUntracked(e.target.checked)} />Include untracked files</label>}
      {action === 'switch' && !remoteSwitch && !occupiedPath && <><label className="checkbox-label"><input type="checkbox" checked={stashBeforeSwitch} onChange={e => setStashBeforeSwitch(e.target.checked)} />Stash local changes before switching</label><div className="dialog-hint">Includes untracked files and preserves staged changes. After switching, you can reapply the stash or keep it saved.</div></>}
      {hasTarget && <><label htmlFor="action-target">{action === 'branch-create' || action === 'branch-recover' ? 'New branch name' : action === 'rename' ? 'New repository-relative path' : action === 'merge' || action === 'squash' ? 'Source branch or commit' : 'Branch or commit'}</label>{action === 'switch' || action === 'branch-delete' ? <select id="action-target" autoFocus value={selectedSwitch ? branchRef(selectedSwitch) : target} onChange={e => setTarget(e.target.value)} required><option value="">Select a branch…</option>{options?.branches.filter(b => !b.current && (action === 'switch' || !b.remote)).map(b => <option key={`${b.remote}:${b.name}`} value={action === 'switch' ? branchRef(b) : b.name}>{b.name}{b.remote ? ' (remote)' : otherWorktree(b,repo.root) ? ' (open in worktree)' : ''}</option>)}</select> : <input id="action-target" autoFocus value={target} onChange={e => setTarget(e.target.value)} list="action-branches" required spellCheck={false} />}<datalist id="action-branches">{options?.branches.map(b => <option key={b.name} value={b.name} />)}</datalist></>}
      {occupiedPath && <div className="worktree-switch-notice" role="status"><strong>This branch is already open in another worktree</strong><code>{occupiedPath}</code><p>Open that working directory to use <b>{localSwitchName}</b>. Both working directories keep their current files and staged changes. Opening it does not stash, pull, or switch branches.</p></div>}
      {remoteSwitch && !occupiedPath && <div className="remote-switch-plan"><strong>{selectedSwitch!.name} → local {localSwitchName}</strong><ol><li>Fetch the latest version of this remote branch using your Git credentials.</li><li>Stash current staged, unstaged, and untracked files.</li><li>Create its local tracking branch, or fast-forward the existing one. If local commits have diverged, stop before switching so you can merge or rebase explicitly.</li><li>Ask whether to reapply your saved changes, preserving their staged state.</li></ol></div>}
      {isRemote && <><label htmlFor="action-remote">{action === 'push' ? 'Publish to remote' : action === 'pull' ? 'Download from remote' : 'Remote'}</label><select id="action-remote" autoFocus value={remote} onChange={e => setRemote(e.target.value)} required>{!options?.remotes.length && <option value="">{options ? 'No remotes configured' : 'Loading remotes...'}</option>}{options?.remotes.map(r => <option key={r}>{r}</option>)}</select><div className="dialog-hint">Uses your existing Git credentials. No account is required in Look-in-Git.</div></>}
      {(action === 'push' || action === 'pull') && <><label htmlFor="remote-branch">Remote branch</label><input id="remote-branch" value={remoteBranch} onChange={e=>setRemoteBranch(e.target.value)} required spellCheck={false}/><div className="dialog-hint">Defaults to the configured upstream. An explicit destination keeps existing tracking unchanged.</div></>}
      {isStashApply && <><label htmlFor="action-stash">Saved stash</label><select id="action-stash" autoFocus value={stash} onChange={e => setStash(e.target.value)} required>{!options?.stashes.length && <option value="">No saved stashes</option>}{options?.stashes.map(s => <option key={s.ref} value={s.ref}>{s.ref} · {s.subject}</option>)}</select></>}
      {needsReview && <>
        {review && <ActionReviewPanel review={review} />}
        {!review && reviewReady && !reviewError && <div className="action-review-loading" role="status"><LoaderCircle size={15} className="spin" />Reading the action preview...</div>}
        {!reviewReady && options && <p className="action-count-note">{action === 'push' || action === 'pull' ? 'Choose a configured remote to review this action.' : 'Choose a source branch or enter a commit to review this action.'}</p>}
        {reviewError && <p className="form-error" role="alert">{reviewError}</p>}
        {(review || reviewError) && <button type="button" className="review-refresh" onClick={() => setReviewVersion(version => version + 1)}>Refresh review</button>}
      </>}
      {(error || failureMessage) && <p className="form-error" role="alert">{failureMessage || error}</p>}
      <div className="dialog-actions">{hasAbort ? <button type="button" className="button danger-text" disabled={busy} onClick={() => void run({ action: `${action}-abort` as ActionKind })}><Undo2 size={14} />Abort {action}</button> : <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>}<button className={`button ${action === 'discard' ? 'danger-button' : 'primary'}`} type="submit" disabled={busy || !options || (action === 'discard' && !discard) || (needsReview && (!review || !!review.blocked)) || (isRemote && !remote) || (isStashApply && !stash)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? 'Running…' : occupiedPath ? 'Open existing worktree' : review?.submitLabel ?? (remoteSwitch ? `Fetch & switch to ${localSwitchName}` : actionLabels[action])}</button></div>
      </fieldset>
    </form>
  </dialog>;
}
