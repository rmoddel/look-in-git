import { ChevronDown, ChevronRight, FileCode2, File, Folder, FolderOpen, Search, ChevronsDownUp, Check, Minus } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type MouseEvent, type DragEvent } from 'react';
import type { ActionRequest, ChangedFile, Scope } from '../../shared/types';

export const fileKey = (file: ChangedFile) => `${file.scope}\0${file.path}`;
export const scopeLabels: Record<Scope, string> = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked', commit: 'Changed files', compare: 'Changed files' };
export const statusLabels: Record<string, string> = { M: 'Modified', A: 'New', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'New' };
interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; file?: ChangedFile }
function makeTree(files: ChangedFile[]) {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const file of files) {
    let node = root;
    const segments = file.path.split('/');
    segments.forEach((segment, i) => {
      if (!node.children.has(segment)) node.children.set(segment, { name: segment, path: segments.slice(0, i + 1).join('/'), children: new Map() });
      node = node.children.get(segment)!;
    });
    node.file = file;
  }
  return root;
}
export function displayPath(value: string) { return value.replace(/[\r\n\t]/g, c => c === '\n' ? '↵' : c === '\t' ? '⇥' : '␍'); }
export function Counts({ file }: { file: Pick<ChangedFile, 'added' | 'deleted' | 'binary'> }) {
  return <span className="line-counts">{file.binary ? <span className="muted">binary</span> : <><span className="add-count">{file.added === null ? '—' : `+${file.added}`}</span><span className="delete-count">{file.deleted === null ? '—' : `−${file.deleted}`}</span></>}</span>;
}
interface Props {
  files: ChangedFile[]; selected: string; onSelect: (file: ChangedFile) => void;
  collapsed: Set<string>; onToggle: (key: string) => void; prefix: string;
  onContextMenu: (event: MouseEvent, file: ChangedFile, stagedFile?: ChangedFile) => void;
  onAction: (body: ActionRequest) => Promise<boolean>; disabled: boolean; refreshError?: string;
}
export function FileTree({ files, selected, onSelect, collapsed, onToggle, prefix, onContextMenu, onAction, disabled, refreshError }: Props) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all');
  const [pendingChecks, setPendingChecks] = useState<Record<string, boolean>>({});
  const contentsId = useId();
  const sectionKey = `${prefix}\0files`, sectionClosed = collapsed.has(sectionKey);
  useEffect(() => { setPendingChecks({}); }, [files, refreshError]);
  const editable = prefix.endsWith(':working');
  const byPath = useMemo(() => {
    const map = new Map<string, ChangedFile[]>();
    for (const file of files) map.set(file.path, [...(map.get(file.path) ?? []), file]);
    return map;
  }, [files]);
  const visible = [...byPath.values()].filter(variants => variants[0].path.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || variants.some(file => file.scope === filter)));
  const tree = makeTree(visible.map(variants => variants.find(file => file.scope === 'unstaged' || file.scope === 'untracked') ?? variants[0]));
  const folders: string[] = [];
  function collect(node: TreeNode) { for (const child of node.children.values()) if (!child.file) { folders.push(`${prefix}:${child.path}`); collect(child); } }
  collect(tree);
  async function toggleStage(file: ChangedFile, checked: boolean) {
    setPendingChecks(previous => ({ ...previous, [file.path]: checked }));
    if (!await onAction({ action: checked ? 'stage' : 'unstage', path: file.path })) setPendingChecks(previous => { const next = { ...previous }; delete next[file.path]; return next; });
  }
  function drop(event: DragEvent, action: 'stage' | 'unstage') {
    event.preventDefault(); event.stopPropagation();
    if (disabled) return;
    try { const source = JSON.parse(event.dataTransfer.getData('application/x-look-in-git-file')); if (source.prefix === prefix) void onAction({ action, path: source.path }); } catch { /* Ignore other drags. */ }
  }
  const renderNodes = (node: TreeNode, depth: number): React.ReactNode => [...node.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)).map(child => {
    const key = `${prefix}:${child.path}`, closed = collapsed.has(key);
    if (!child.file) return <div key={child.path}><button className="folder-row" style={{ paddingLeft: 9 + depth * 15 }} onClick={() => onToggle(key)} aria-label={`${closed ? 'Expand' : 'Collapse'} folder ${displayPath(child.path)}`} aria-expanded={!closed} onKeyDown={event => { if ((event.key === 'ArrowLeft' && !closed) || (event.key === 'ArrowRight' && closed)) { event.preventDefault(); onToggle(key); } }}>{closed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}{closed ? <Folder size={15} /> : <FolderOpen size={15} />}<span>{displayPath(child.name)}</span></button>{!closed && renderNodes(child, depth + 1)}</div>;
    const variants = byPath.get(child.path)!;
    const staged = variants.find(file => file.scope === 'staged'), working = variants.find(file => file.scope === 'unstaged' || file.scope === 'untracked');
    const file = working ?? child.file;
    const partial = !!staged && !!working, fullyStaged = !!staged && !working;
    const selectedVariant = variants.find(file => fileKey(file) === selected);
    const status = variants.some(file => file.conflict) ? 'U' : variants.some(file => file.status === 'A' || file.status === '?') ? 'A' : variants.find(file => file.status === 'R') ? 'R' : file.status;
    const stateLabel = partial ? 'Partially staged' : fullyStaged ? 'Staged' : file.scope === 'untracked' ? 'Untracked · not staged' : 'Unstaged';
    const totals = { added: variants.some(file => file.added === null) ? null : variants.reduce((sum, file) => sum + file.added!, 0), deleted: variants.some(file => file.deleted === null) ? null : variants.reduce((sum, file) => sum + file.deleted!, 0), binary: variants.some(file => file.binary) };
    return <div className="file-entry" key={child.path}>{editable && <input className="stage-checkbox" style={{ left: 12 + depth * 15 }} type="checkbox" ref={element => { if (element) element.indeterminate = partial && pendingChecks[file.path] === undefined; }} aria-label={`${fullyStaged ? 'Unstage' : 'Stage'} ${displayPath(file.path)}`} title={partial ? 'Partially staged. Check to stage remaining changes; right-click to unstage.' : fullyStaged ? 'Unstage this file' : 'Stage this file'} checked={pendingChecks[file.path] ?? fullyStaged} disabled={disabled || pendingChecks[file.path] !== undefined} onChange={() => void toggleStage(file, !fullyStaged)} />}<button className={`file-row unified-file-row ${selectedVariant ? 'selected' : ''}`} style={{ paddingLeft: (editable ? 33 : 14) + depth * 15 }} onClick={() => onSelect(selectedVariant ?? file)} onContextMenu={event => onContextMenu(event, file, staged)} draggable={editable && !disabled} onDragStart={event => { event.dataTransfer.setData('application/x-look-in-git-file', JSON.stringify({ prefix, path: file.path })); event.dataTransfer.effectAllowed = 'move'; }} title={`${displayPath(file.path)}\n${statusLabels[status]}${editable ? ` · ${stateLabel}` : ''}${file.oldPath ? `\nRenamed from ${displayPath(file.oldPath)}` : ''}`} aria-pressed={!!selectedVariant}>
      {file.path.includes('.') ? <FileCode2 size={14} className="file-icon" /> : <File size={14} className="file-icon" />}<span className="file-label"><span className="file-name">{displayPath(child.name)}</span>{editable && <span className={`staging-state ${partial ? 'partial' : fullyStaged ? 'staged' : ''}`}>{partial ? <Minus size={10} /> : fullyStaged ? <Check size={10} /> : <span className="unstaged-state-dot" />}{stateLabel}</span>}</span><Counts file={totals} /><span className={`file-status-label status-${status}`}>{statusLabels[status]}</span>
    </button></div>;
  });
  return <div className={`file-tree ${sectionClosed ? "is-collapsed" : ""}`}>
    <div className="tree-toolbar"><button className="files-disclosure" aria-expanded={!sectionClosed} aria-controls={contentsId} aria-label={sectionClosed ? "Expand files" : "Collapse files"} onClick={() => onToggle(sectionKey)}>{sectionClosed ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}<span>FILES</span><span className="count-pill">{byPath.size}</span></button>{editable && <span className="tree-stage-targets"><button disabled={disabled || !files.some(file => file.scope !== 'staged')} title="Stage all changes, or drop a file here to stage it" onClick={() => void onAction({ action: 'stage-all' })} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, 'stage')}><Check size={12} />Stage</button><button disabled={disabled || !files.some(file => file.scope === 'staged')} title="Unstage all changes, or drop a file here to unstage it" onClick={() => void onAction({ action: 'unstage-all' })} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, 'unstage')}><Minus size={12} />Unstage</button></span>}<button title={folders.some(key => !collapsed.has(key)) ? "Collapse all folders" : "Expand all folders"} aria-label={folders.some(key => !collapsed.has(key)) ? "Collapse all folders" : "Expand all folders"} className="icon-button ml-auto" disabled={sectionClosed || !folders.length} onClick={() => { const collapse = folders.some(key => !collapsed.has(key)); folders.filter(key => collapsed.has(key) !== collapse).forEach(onToggle); }}><ChevronsDownUp size={15} /></button></div>
    <div id={contentsId} className="file-tree-body" hidden={sectionClosed}>
    <div className="tree-search"><Search size={14} /><input aria-label="Filter changed files" value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter files…" /></div>
    {editable && <select className="scope-filter" aria-label="Change section" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All changes · stable folder tree</option><option value="unstaged">With unstaged changes</option><option value="staged">With staged changes</option><option value="untracked">Untracked files</option></select>}
    <div className="tree-scroll" role="region" aria-label="Changed files">{renderNodes(tree, 0)}{!visible.length && <p className="tree-empty">{search ? 'No files match your filter.' : files.length ? 'No changes in this filter.' : 'No changed files.'}</p>}</div>
    {editable && <div className="tree-legend"><span><Check size={11} />Staged</span><span><Minus size={11} />Partial</span><span><i className="legend-dot modified" />Unstaged</span></div>}
    </div>
  </div>;
}
