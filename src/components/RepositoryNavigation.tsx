import { useState, type MouseEvent } from 'react';
import { Activity, Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, Cloud, History, ArrowLeftRight } from 'lucide-react';
import type { ActionOptions, Branch, Stash, WorkingCopy } from '../../shared/types';
import { readPreference, savePreference } from '../api';
import type { ToolsSection } from './WorkspaceTools';
import { branchRef, otherWorktree } from '../../shared/branches';
import { WorktreeSidebar } from './WorktreeSidebar';

export function SyncStatus({ working }: { working: WorkingCopy | null }) {
  if (!working) return null;
  if (!working.upstream) return <span className="sync-unset" title="This branch has no available upstream. Push it to set one.">No upstream</span>;
  return <span className="sync-status" title={`${working.ahead} commits ahead, ${working.behind} commits behind ${working.upstream}. Based on the last fetch.`} aria-label={`${working.ahead} commits ahead and ${working.behind} commits behind ${working.upstream}`}><span className={working.ahead ? 'ahead active' : 'ahead'}><ArrowUp size={13} />{working.ahead}</span><span className={working.behind ? 'behind active' : 'behind'}><ArrowDown size={13} />{working.behind}</span></span>;
}

interface Props {
  root: string; repoId: string; working: WorkingCopy | null; options: ActionOptions | null; active: boolean;
  view: 'working' | 'history' | 'branches' | 'compare'; onView: (view: 'working' | 'history' | 'branches' | 'compare') => void;
  historyRef: string;
  onWorking: () => void; onBranch: (branch: Branch) => void; onSwitch: (branch: Branch) => void;
  onTools: (section: ToolsSection) => void;
  onMerge: (name: string) => void; onStash: (stash: Stash) => void;
  onContext: (event: MouseEvent, context?: { branch?: Branch; stash?: Stash }) => void;
  onOpenWorktree: (repo: import('../../shared/types').Repository) => void; onWorktreesChanged: () => void; onCompareWorktree: (branch: string) => void; onWorktreesDiscovered: (trees: import('../../shared/worktrees').WorktreeInfo[]) => void; refresh: number;
}
export function RepositoryNavigation({ root, repoId, working, options, active, view, historyRef, onView, onWorking, onBranch, onSwitch, onMerge, onStash, onContext, onTools, onOpenWorktree, onWorktreesChanged, onCompareWorktree, onWorktreesDiscovered, refresh }: Props) {
  const [closed, setClosed] = useState<string[]>(() => readPreference(`nav-sections:${root}`, []));
  function toggle(section: string) { setClosed(previous => { const next = previous.includes(section) ? previous.filter(s => s !== section) : [...previous, section]; savePreference(`nav-sections:${root}`, next); return next; }); }
  const branchRows = (remote: boolean) => options?.branches.filter(branch => branch.remote === remote).map(branch => <button className={`repo-nav-row ${branch.current ? 'current-branch' : ''} ${view === 'history' && (historyRef === branchRef(branch) || historyRef === 'HEAD' && branch.current) ? 'browsing-branch' : ''}`} key={branchRef(branch)} aria-label={`View history of ${branch.name}${branch.remote ? " (remote)" : ""}`} aria-pressed={view === "history" && (historyRef === branchRef(branch) || historyRef === "HEAD" && branch.current)} title={`${branch.name}\n${branch.subject}\nClick to browse history and commits.\n${otherWorktree(branch,root) ? `Open existing worktree: ${branch.worktreePath}. Double-click for details.` : branch.remote ? 'Double-click to fetch, stash changes, and switch locally.' : 'Double-click to switch.'} Right-click for Git actions.`} onClick={() => onBranch(branch)} onDoubleClick={() => { if (!branch.current) onSwitch(branch); }} onContextMenu={event => onContext(event, { branch })} draggable onDragStart={event => { event.dataTransfer.setData('application/x-look-in-git-branch', JSON.stringify({ repoId, name: branchRef(branch) })); event.dataTransfer.effectAllowed = 'link'; }}><GitBranch size={13} /><span className="nav-row-name">{branch.name}</span>{branch.current && <span className="nav-head">HEAD</span>}{otherWorktree(branch,root) && <span className="nav-head" title={branch.worktreePath}>WT</span>}</button>);
  function section(label: string, icon: React.ReactNode, count: number, children: React.ReactNode) { return <div className="repo-nav-section"><button className="repo-section-toggle" aria-expanded={!closed.includes(label)} onClick={() => toggle(label)}>{closed.includes(label) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}{icon}<span>{label}</span><span className="nav-count">{count}</span></button>{!closed.includes(label) && <div className="repo-section-children">{children}</div>}</div>; }
  return <div className="repository-navigation">
    <div className="working-branch-label">WORKING BRANCH</div>
    <button className={`working-branch ${active ? 'active' : ''}`} onClick={onWorking} onContextMenu={event => onContext(event, { branch: options?.branches.find(branch => branch.current) })} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-look-in-git-branch')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); try { const source = JSON.parse(event.dataTransfer.getData('application/x-look-in-git-branch')); if (source.repoId === repoId && source.name !== `refs/heads/${working?.branch}`) onMerge(source.name); } catch { /* Ignore unrelated drags. */ } }}><GitBranch size={15} /><strong>{working?.branch ?? 'Loading…'}</strong><SyncStatus working={working} /></button>
    <button className={`repo-nav-row working-changes-link ${active ? 'active' : ''}`} onClick={onWorking}><Activity size={13} /><span className="nav-row-name">Working Changes</span><span className="nav-count">{working ? new Set(working.files.map(f => f.path)).size : '—'}</span></button>
    <nav className="repository-views" aria-label="Repository views">{([{ id: 'history', label: 'History', icon: History }, { id: 'branches', label: 'Branches', icon: GitBranch }, { id: 'compare', label: 'Compare', icon: ArrowLeftRight }] as const).map(item => <button key={item.id} className={`repo-nav-row ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}><item.icon size={14} /><span className="nav-row-name">{item.label}</span></button>)}</nav>
    <div className="repo-tools-links"><button className="repo-nav-row" onClick={()=>onTools('recovery')}><History size={14}/><span>Reflog & recovery</span></button><button className="repo-nav-row" onClick={()=>onTools('tags')}><Archive size={14}/><span>Tags</span></button><button className="repo-nav-row" onClick={()=>onTools('remotes')}><Cloud size={14}/><span>Remotes & tracking</span></button></div>
    <WorktreeSidebar repo={{id:repoId,name:root.split(/[\\/]/).filter(Boolean).at(-1) || root,root}} activeRoot={root} options={options} refresh={refresh} onOpen={onOpenWorktree} onChanged={onWorktreesChanged} onCompare={onCompareWorktree} onDiscovered={onWorktreesDiscovered}/>
    {section('Stashes', <Archive size={13} />, options?.stashes.length ?? 0, options?.stashes.length ? options.stashes.map(stash => <button key={stash.hash} className="repo-nav-row stash-row" title={`${stash.ref} · ${stash.subject}`} onClick={() => onStash(stash)} onContextMenu={event => onContext(event, { stash })}><Archive size={12} /><span className="nav-row-name">{stash.subject.replace(/^(?:On|WIP on) [^:]+: /, '')}</span></button>) : <p className="nav-empty">{options ? 'No saved stashes' : 'Loading…'}</p>)}
    {section('Local Branches', <GitBranch size={13} />, options?.branches.filter(b => !b.remote).length ?? 0, options?.branches.some(b => !b.remote) ? branchRows(false) : <p className="nav-empty">{options ? 'No local branches yet' : 'Loading…'}</p>)}
    {section('Remote Branches', <Cloud size={13} />, options?.branches.filter(b => b.remote).length ?? 0, options?.branches.some(b => b.remote) ? branchRows(true) : <p className="nav-empty">{options ? 'No remote branches' : 'Loading…'}</p>)}
  </div>;
}
