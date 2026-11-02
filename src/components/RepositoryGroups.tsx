import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderGit2, Pencil, Plus, Search, Tags, Trash2, X } from 'lucide-react';
import type { Repository } from '../../shared/types';
import { ALL_GROUPS, UNGROUPED, assignGroup, createGroup, groupLabel, groupedRepositories, removeGroup, renameGroup, repositoryGroup, type RepositoryGroups } from '../repository-groups';

interface PickerProps {
  state: RepositoryGroups; repositories: Repository[]; disabled: boolean;
  onSelect: (id: string) => void; onManage: (draft?: string) => void;
}
export function GroupPicker({ state, repositories, disabled, onSelect, onManage }: PickerProps) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const groups = [{ id: ALL_GROUPS, name: 'All groups' }, { id: UNGROUPED, name: 'Ungrouped' }, ...state.groups.slice().sort((a,b) => a.name.localeCompare(b.name))];
  const matches = groups.filter(group => group.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="group-picker" ref={container} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...container.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <button ref={trigger} className="group-trigger" aria-label={`Repository group: ${groupLabel(state)}`} title={`${groupLabel(state)} · Filter repositories by company or custom group`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setOpen(!open); setSearch(''); }}><Tags size={14}/><span>{groupLabel(state)}</span><ChevronDown size={11}/></button>
    {open && <div className="group-popover">
      <label className="group-search"><Search size={14}/><input ref={input} aria-label="Find repository group" placeholder="Find a group…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if(event.key === 'Enter' && matches.length) { event.preventDefault(); onSelect(matches[0].id); setOpen(false); trigger.current?.focus(); } }}/></label>
      <div className="group-options" role="menu" aria-label="Repository groups">{matches.map(group => <button key={group.id} role="menuitemradio" aria-checked={state.activeGroup === group.id} onClick={() => { onSelect(group.id); setOpen(false); trigger.current?.focus(); }}><span className="group-check">{state.activeGroup === group.id && <Check size={13}/>}</span><span>{group.name}</span><small>{groupedRepositories(repositories,state,group.id).length}</small></button>)}{!matches.length && <p>No matching groups.</p>}</div>
      <button className="group-organize" onClick={() => { setOpen(false); onManage(search.trim()); }}><Plus size={14}/>{search.trim() && !matches.length ? `Create “${search.trim().slice(0,48)}”…` : 'Organize repositories…'}</button>
    </div>}
  </div>;
}

interface ManagerProps { state: RepositoryGroups; repositories: Repository[]; currentRoot?: string; draft: string; onChange: (state:RepositoryGroups) => void; onClose: () => void }
export function GroupManager({state,repositories,currentRoot,draft,onChange,onClose}:ManagerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name,setName] = useState(draft), [search,setSearch] = useState(''), [error,setError] = useState('');
  const [editing,setEditing] = useState<string|null>(null), [rename,setRename] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  function update(task: () => RepositoryGroups) { try { onChange(task());setError('');return true; } catch(e) {setError((e as Error).message);return false;} }
  const groups = state.groups.slice().sort((a,b) => a.name.localeCompare(b.name));
  const terms=search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = repositories.filter(repo => terms.every(term => `${repo.name} ${repo.root} ${groupLabel(state,repositoryGroup(state,repo.root))}`.toLocaleLowerCase().includes(term)));
  return <dialog ref={dialog} className="workspace-tools group-manager" aria-labelledby="groups-title" onCancel={onClose}>
    <header className="tools-header"><div><small>Your local workspace</small><h2 id="groups-title"><Tags size={19}/>Organize repositories</h2></div><button className="icon-button" aria-label="Close repository groups" onClick={onClose}><X size={19}/></button></header>
    <div className="tools-body">
      <p className="tools-explanation">Company, client, Personal—use any label. Choose a group in the top bar to see only its repositories.</p>
      <form className="group-create" onSubmit={event => {event.preventDefault();if(update(() => createGroup(state,name,`group-${crypto.randomUUID()}`)))setName('');}}><label htmlFor="new-group-name">New group</label><div><input id="new-group-name" value={name} maxLength={48} onChange={event => setName(event.target.value)} placeholder="e.g. Acme, Personal, Open source" autoFocus required/><button className="button" disabled={!name.trim()} type="submit"><Plus size={14}/>Create group</button></div></form>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="group-labels">{groups.map(group => <div className="group-label" key={group.id}>{editing === group.id ? <form onSubmit={event => {event.preventDefault();if(update(() => renameGroup(state,group.id,rename)))setEditing(null);}}><input aria-label={`New name for ${group.name}`} value={rename} onChange={event=>setRename(event.target.value)} maxLength={48} autoFocus required/><button className="icon-button" aria-label="Save group name" type="submit"><Check size={13}/></button><button type="button" className="icon-button" aria-label="Cancel rename" onClick={()=>setEditing(null)}><X size={13}/></button></form> : <><span>{group.name}</span><small>{groupedRepositories(repositories,state,group.id).length}</small><button className="icon-button" aria-label={`Rename group ${group.name}`} onClick={()=>{setEditing(group.id);setRename(group.name);}}><Pencil size={12}/></button><button className="icon-button" title="Remove this label; repositories become Ungrouped" aria-label={`Remove group ${group.name}`} onClick={()=>update(()=>removeGroup(state,group.id))}><Trash2 size={12}/></button></>}</div>)}</div>
      <label className="group-repo-search"><Search size={15}/><input aria-label="Find repositories to organize" placeholder="Find repositories by name, path, or group…" value={search} onChange={event=>setSearch(event.target.value)}/></label>
      <div className="group-repo-list">{visible.map(repo=><div className={`group-repo-row ${repo.root===currentRoot?'current':''}`} key={repo.id}><FolderGit2 size={17}/><div><strong>{repo.name}{repo.root===currentRoot && <small>Current</small>}</strong><span title={repo.root}>{repo.root}</span></div><select aria-label={`Group for ${repo.root}`} value={repositoryGroup(state,repo.root)} onChange={event=>onChange(assignGroup(state,repo.root,event.target.value))}><option value={UNGROUPED}>Ungrouped</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></div>)}{!visible.length && <p className="tree-empty">{repositories.length?'No repositories match your search.':'Open a repository with + in the top bar, then assign it a group here.'}</p>}</div>
    </div>
    <footer className="group-manager-footer"><span>Saved in this browser. Labels never change repository files.</span><button className="button primary" onClick={onClose}>Done</button></footer>
  </dialog>;
}
