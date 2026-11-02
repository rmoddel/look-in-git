import { useEffect, useRef, useState } from 'react';
import { FolderGit2, FolderSearch, LoaderCircle, Plus, X, ArrowRight } from 'lucide-react';
import type { Repository } from '../../shared/types';
import { api } from '../api';
import type { RepositoryGroup } from '../repository-groups';

export function OpenRepository({ onClose, onOpen, defaultPath, groups, defaultGroup, initialMode = 'open' }: { onClose: () => void; onOpen: (repo: Repository, groupId?:string) => void; defaultPath: string; groups:RepositoryGroup[]; defaultGroup:string; initialMode?:'open'|'clone'|'init' }) {
  const [groupId,setGroupId] = useState(defaultGroup);
  const [path, setPath] = useState(defaultPath);
  const [mode, setMode] = useState<'open'|'clone'|'init'>(initialMode);
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [branch,setBranch] = useState('main');
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function open(value: string) {
    setError(''); setBusy(true);
    try { onOpen(await api<Repository>('/repositories', { method: 'POST', body: JSON.stringify({ path: value }) }), groupId || undefined); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function scan() {
    setError(''); setBusy(true); setRoots([]); setNote('');
    try {
      const result = await api<{ roots: string[]; truncated: boolean }>('/discover', { method: 'POST', body: JSON.stringify({ path }) });
      setRoots(result.roots); setNote(result.roots.length ? `Found ${result.roots.length} repositories${result.truncated ? ' · scan limit reached' : ''}. Select one to open.` : 'No repositories found within three folder levels. Try another folder.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true);setError('');
    try { const repo=await api<Repository>('/repositories/create',{method:'POST',body:JSON.stringify({kind:mode,parent:path,name,...(mode==='clone'?{url}:{branch})})});onOpen(repo,groupId || undefined);onClose(); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <dialog className="open-dialog" ref={dialog} onCancel={e=>{if(busy)e.preventDefault();else onClose();}} onClick={e => { if (!busy && e.target === e.currentTarget) onClose(); }} aria-labelledby="open-title">
    <div className="dialog-heading"><div className="dialog-icon"><FolderGit2 size={24} /></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close add repository"><X size={19} /></button></div>
    <h2 id="open-title">Your next workspace</h2><p>Open a project, clone a remote, or start a new repository.</p>
    {groups.length>0 && <label className="onboarding-group">Repository group<select aria-label="Group for opened repository" value={groupId} disabled={busy} onChange={event=>setGroupId(event.target.value)}><option value="">Keep existing group / Ungrouped</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
    <div className="tools-tabs onboarding-tabs">{(['open','clone','init'] as const).map(value=><button disabled={busy} key={value} className={mode===value?'active':''} onClick={()=>{setMode(value);setError('');setNote('');setRoots([]);}}>{value==='open'?'Open local':value==='clone'?'Clone':'Create new'}</button>)}</div>
    {mode==='open'? <>
    <form onSubmit={e => { e.preventDefault(); void open(path); }}><label htmlFor="repo-path">Local folder path</label><input id="repo-path" autoFocus value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Users\you\code\your-project" spellCheck={false} autoComplete="off" /><div className="dialog-hint">Paste an absolute folder path. Your files stay on this computer.</div>
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy || !path.trim()} onClick={() => void scan()}><FolderSearch size={16} />Discover projects</button><button type="submit" className="button primary" disabled={busy || !path.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Open repository</button></div>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}{note && <p className="discovery-note">{note}</p>}
    {roots.length > 0 && <div className="discovery-results">{roots.map(root => <button disabled={busy} key={root} onClick={() => void open(root)}><FolderGit2 size={17} /><span>{root}</span><ArrowRight size={15} /></button>)}</div>}
    </> : <form className="onboarding-form" onSubmit={e=>{e.preventDefault();void create();}}><fieldset disabled={busy}>
      {mode==='clone'&&<label>Repository address<input aria-label="Clone repository address" required placeholder="git@github.com:team/project.git" value={url} onChange={e=>setUrl(e.target.value)} spellCheck={false}/></label>}
      <label>Parent folder<input aria-label="New repository parent folder" required value={path} onChange={e=>setPath(e.target.value)} spellCheck={false}/></label><label>New folder name<input aria-label="New repository folder name" required value={name} onChange={e=>setName(e.target.value)} placeholder="my-project" spellCheck={false}/></label>
      {mode==='init'&&<label>Initial branch<input aria-label="Initial branch name" value={branch} onChange={e=>setBranch(e.target.value)} required/></label>}
      <p className="dialog-hint">Creates a new folder. Existing folders are never overwritten. {mode==='clone'?'Uses your Git credential helper or SSH agent. Submodules are not downloaded automatically.':'The new repository starts without a commit.'}</p>
      {error&&<p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit">{busy?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} {busy?'Working…':mode==='clone'?'Clone repository':'Create repository'}</button></div>
    </fieldset></form>}
  </dialog>;
}
