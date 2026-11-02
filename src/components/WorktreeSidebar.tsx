import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, ChevronDown, ChevronRight, Circle, FolderGit2, FolderOpen, GitBranch, LockKeyhole, MoreHorizontal, Plus, RefreshCw, Wrench } from 'lucide-react';
import type { ActionOptions, Repository } from '../../shared/types';
import type { WorktreeInfo } from '../../shared/worktrees';
import { api } from '../api';

type Worktree = WorktreeInfo;
interface Props { repo: Repository; activeRoot: string; options: ActionOptions | null; refresh: number; onOpen: (repo: Repository) => void; onChanged: () => void; onCompare: (branch: string) => void; onDiscovered: (trees: WorktreeInfo[]) => void }
const keyFor = (root: string) => `look-in-git:worktree-agents:${root}`;

export function WorktreeSidebar({ repo, activeRoot, options, refresh, onOpen, onChanged, onCompare, onDiscovered }: Props) {
  const [trees, setTrees] = useState<Worktree[]>([]), [expanded, setExpanded] = useState(true);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [createOpen, setCreateOpen] = useState(false);
  const metadataRoot = trees.find(tree => tree.main)?.path ?? repo.root;
  const [agentLabels, setAgentLabels] = useState<Record<string,string>>(() => { try { return JSON.parse(localStorage.getItem(keyFor(repo.root)) || '{}'); } catch { return {}; } });
  const [mode, setMode] = useState<'existing'|'new'>('new'), [branch, setBranch] = useState(''), [newBranch, setNewBranch] = useState(''), [base, setBase] = useState('HEAD'), [destination, setDestination] = useState('');
  async function load(signal?: AbortSignal) {
    try { const result = await api<Worktree[]>(`/repositories/${repo.id}/worktrees`, { signal }); setTrees(result); onDiscovered(result); setError(''); }
    catch (e) { if (!signal?.aborted) setError((e as Error).message); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [repo.id, refresh]);
  useEffect(() => { try { setAgentLabels(JSON.parse(localStorage.getItem(keyFor(metadataRoot)) || '{}')); } catch { setAgentLabels({}); } }, [metadataRoot]);
  useEffect(() => { if (!destination) setDestination(`${repo.root.replace(/[\\/]+$/, '')}-worktrees`); }, [repo.root]);
  async function action(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await api(`/repositories/${repo.id}/worktrees/action`, { method: 'POST', body: JSON.stringify(body) }); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function open(tree: Worktree) {
    if (tree.prunable) return;
    setBusy(true); setError('');
    try { onOpen(await api<Repository>('/repositories', { method: 'POST', body: JSON.stringify({ path: tree.path }) })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function assignAgent(tree: Worktree) {
    const current = agentLabels[tree.path] ?? '';
    const name = window.prompt('Optional agent label for this worktree (stored only in Look-in-Git):', current);
    if (name === null) return;
    const next = { ...agentLabels };
    if (name.trim()) next[tree.path] = name.trim().slice(0, 80); else delete next[tree.path];
    setAgentLabels(next); localStorage.setItem(keyFor(metadataRoot), JSON.stringify(next));
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    await action({ action: 'create', path: destination, ...(mode === 'existing' ? { branch } : { newBranch, base }) });
    setCreateOpen(false); setBranch(''); setNewBranch('');
  }
  async function browseForParent() {
    const desktop = (window as Window & { lookInGitDesktop?: { chooseDirectory?: () => Promise<string | null> } }).lookInGitDesktop;
    let parent: string | null = null;
    try {
      if (desktop?.chooseDirectory) parent = await desktop.chooseDirectory();
      else parent = window.prompt('Enter the parent folder path for the new worktree:', destination.replace(/[\\/][^\\/]+$/, ''));
    } catch (e) { setError((e as Error).message); return; }
    if (!parent) return;
    const leaf = destination.split(/[\\/]/).filter(Boolean).at(-1) || `${repo.name}-worktree`;
    const separator = /\\/.test(repo.root) ? '\\' : '/';
    setDestination(parent.replace(/[\\/]+$/, '') + separator + leaf);
  }
  function menu(tree: Worktree, choice: 'move'|'lock'|'unlock'|'agent'|'remove'|'remove-delete-branch') {
    if (choice === 'agent') return assignAgent(tree);
    if (choice === 'move') { const target = window.prompt('Choose the new full folder path for this worktree:', tree.path); if (target && target !== tree.path) void action({ action: 'move', path: tree.path, target }); }
    else if (choice === 'lock') void action({ action: 'lock', path: tree.path });
    else if (choice === 'unlock') void action({ action: 'unlock', path: tree.path });
    else if (choice === 'remove' || choice === 'remove-delete-branch') void action({ action: 'remove', path: tree.path, confirm: true, ...(choice === 'remove-delete-branch' ? { deleteBranch: true } : {}) }, choice === 'remove-delete-branch' ? `Remove this clean worktree and delete branch ${tree.branch}? Branch deletion only succeeds if Git confirms it has been merged. Uncommitted work is never force-removed.` : `Remove ${tree.path}? Git will refuse if it contains uncommitted changes. No branch will be deleted.`);
  }
  return <section className="worktree-sidebar-section">
    <div className="worktree-sidebar-heading"><button className="repo-section-toggle" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<FolderGit2 size={13}/><span>Worktrees</span><span className="nav-count">{trees.length || '…'}</span></button><button className="icon-button" title="Refresh worktrees" aria-label="Refresh worktrees" disabled={busy} onClick={() => void load()}><RefreshCw size={12}/></button><button className="icon-button" title="Create worktree" aria-label="Create worktree" disabled={busy} onClick={() => setCreateOpen(v => !v)}><Plus size={14}/></button></div>
    {expanded && <div className="worktree-sidebar-list">
      {trees.map(tree => <div className={`worktree-nav-item ${activeRoot === tree.path ? 'active' : ''}`} key={tree.path}>
        <button className="worktree-nav-select" title={`${tree.path}\n${tree.branch || 'Detached HEAD'} · ${tree.head.slice(0, 8)}\n${tree.dirty ? `Local changes: ${tree.staged} staged, ${tree.unstaged} unstaged, ${tree.untracked} new` : 'Clean'}${tree.locked ? ` · Locked${tree.lockReason ? `: ${tree.lockReason}` : ''}` : ''}${tree.prunable ? ` · Missing folder${tree.prunableReason ? `: ${tree.prunableReason}` : ''}` : ''}`} onClick={() => void open(tree)} disabled={busy || tree.prunable}>
          {tree.prunable ? <AlertTriangle size={13} className="worktree-state-bad"/> : tree.dirty ? <Circle size={12} className="worktree-state-dirty"/> : <CheckCircle2 size={13} className="worktree-state-clean"/>}
          <span className="worktree-nav-copy"><strong>{tree.name || (tree.main ? 'Main worktree' : tree.branch || 'Detached worktree')}</strong><small><GitBranch size={10}/>{tree.branch || `Detached · ${tree.head.slice(0,8)}`}{tree.locked && <LockKeyhole size={10}/>}</small>{agentLabels[tree.path] && <small className="agent-worktree-label">Agent · {agentLabels[tree.path]}</small>}<small className="worktree-nav-path">{tree.path}</small></span>
          {tree.dirty && <span className="worktree-dirty-count" title={`${tree.staged} staged, ${tree.unstaged} unstaged, ${tree.untracked} untracked`}>{tree.staged + tree.unstaged + tree.untracked}</span>}
        </button>{tree.branch && tree.path !== activeRoot && <button className="icon-button worktree-more" title={`Compare ${tree.branch} with this branch`} aria-label={`Compare ${tree.branch}`} onClick={() => onCompare(tree.branch)}><ArrowLeftRight size={12}/></button>}<details className="worktree-menu"><summary className="icon-button worktree-more" title="Worktree actions" aria-label={`Actions for ${labelFor(tree)}`}><MoreHorizontal size={14}/></summary><div role="menu" aria-label={`Actions for ${labelFor(tree)}`}><button role="menuitem" disabled={busy || tree.main || tree.prunable || tree.dirty} onClick={() => menu(tree,'move')}>Move worktree…</button><button role="menuitem" disabled={busy || tree.prunable} onClick={() => menu(tree,tree.locked?'unlock':'lock')}>{tree.locked?'Unlock worktree':'Lock worktree'}</button><button role="menuitem" onClick={() => menu(tree,'agent')}>{agentLabels[tree.path]?'Change agent label…':'Assign agent label…'}</button><button role="menuitem" className="danger-text" disabled={busy || tree.main || tree.prunable} onClick={() => menu(tree,'remove')}>Remove worktree…</button>{tree.branch && <button role="menuitem" className="danger-text" disabled={busy || tree.main || tree.prunable} onClick={() => menu(tree,'remove-delete-branch')}>Remove and delete merged branch…</button>}</div></details>
      </div>)}
      {!trees.length && !error && <p className="nav-empty">Finding worktrees…</p>}
      {trees.length > 1 && <p className="worktree-branch-hint">Branches shown here are checked out in their own worktree.</p>}
      <div className="worktree-maintenance"><button className="repo-nav-row" disabled={busy} onClick={() => void action({ action: 'repair', confirm: true }, 'Repair Git links for this repository? Git metadata will be updated to match the discovered worktree folders.') }><Wrench size={12}/>Repair links</button><button className="repo-nav-row" disabled={busy} onClick={() => void action({ action: 'prune', confirm: true }, 'Prune stale worktree records? This removes metadata only for worktree folders that no longer exist.') }><RefreshCw size={12}/>Prune stale records</button></div>
      {createOpen && <form className="worktree-create-inline" onSubmit={event => void create(event)}><strong>Create worktree</strong><label>Folder path<span className="worktree-destination"><input value={destination} onChange={event => setDestination(event.target.value)} required/><button className="icon-button" type="button" title="Choose parent folder" aria-label="Choose parent folder" onClick={() => void browseForParent()}><FolderOpen size={14}/></button></span></label><label>Branch setup<select value={mode} onChange={event => setMode(event.target.value as 'existing'|'new')}><option value="new">Create new branch</option><option value="existing">Use existing branch</option></select></label>{mode === 'new' ? <><label>New branch<input value={newBranch} onChange={event => setNewBranch(event.target.value)} required/></label><label>Start from branch or commit<input value={base} onChange={event => setBase(event.target.value)} required/></label></> : <label>Existing branch<select value={branch} onChange={event => setBranch(event.target.value)} required><option value="">Choose branch</option>{options?.branches.filter(item => !item.remote).map(item => <option key={item.name} value={item.name} disabled={!!item.worktreePath}>{item.name}{item.worktreePath ? ' · in another worktree' : ''}</option>)}</select></label>}<small>A branch can only be checked out in one worktree. Each folder gets its own files and staging area.</small><button className="button primary small" disabled={busy}>{busy ? 'Creating…' : 'Create worktree'}</button></form>}
      {error && <p className="worktree-nav-error" role="alert">{error}</p>}
    </div>}
  </section>;
}
function labelFor(tree: Worktree) { return tree.name || tree.branch || tree.path; }
