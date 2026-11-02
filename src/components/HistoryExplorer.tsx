import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy, Filter, GitBranch, GitCommitHorizontal, GitMerge, Search, X } from 'lucide-react';
import type { Branch, ChangedFile, Commit, CommitDetail, Comparison, Repository } from '../../shared/types';
import { api, query } from '../api';
import { branchRef } from '../../shared/branches';
import { FileTree, fileKey } from './FileTree';
import { DiffViewer, EmptyState } from './DiffViewer';

interface Props { filesVisible: boolean; detailsVisible: boolean; onShowPanels: () => void; repo: Repository; branches: Branch[]; refresh: number; initialRef?: string; initialPath?: string; initialCommit?: string; workingBranch: string; onScopeChange: (ref: string) => void; onContext: (event: MouseEvent, context: {commit?: Commit; file?: ChangedFile}) => void }

interface GraphRow { lane: number; lanesBefore: string[]; lanesAfter: string[]; secondary: Array<{ from: number; to: number }> }
function commitGraph(commits: Commit[]): GraphRow[] {
  const lanes: string[] = [];
  return commits.map(commit => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.indexOf(''); if (lane < 0) lane = lanes.length; lanes[lane] = commit.hash; }
    const before = lanes.slice();
    lanes[lane] = '';
    if (commit.parents[0]) lanes[lane] = commit.parents[0];
    const secondary: GraphRow['secondary'] = [];
    for (const parent of commit.parents.slice(1)) {
      let target = lanes.indexOf(parent);
      if (target < 0) { target = lanes.indexOf(''); if (target < 0) target = lanes.length; lanes[target] = parent; }
      if (target !== lane) secondary.push({ from: lane, to: target });
    }
    while (lanes.at(-1) === '') lanes.pop();
    return { lane, lanesBefore: before, lanesAfter: lanes.slice(), secondary };
  });
}
function CommitGraph({ rows, commits }: { rows: GraphRow[]; commits: Commit[] }) {
  const rowHeight = 78;
  const maxLane = Math.max(0, ...rows.flatMap(row => [row.lane, ...row.lanesBefore.map((_, i) => i), ...row.lanesAfter.map((_, i) => i), ...row.secondary.map(edge => edge.to)]));
  const x = (lane: number) => 12 + lane * 13;
  return <div className="history-graph-column" aria-label="Commit graph"><svg className="history-graph" width={x(maxLane) + 8} height={rows.length * rowHeight} viewBox={`0 0 ${x(maxLane) + 8} ${rows.length * rowHeight}`}>
    {rows.map((row, i) => {
      const top = i * rowHeight, middle = top + rowHeight / 2, bottom = top + rowHeight;
      return <g key={commits[i].hash}>
        {row.lanesBefore.map((hash, lane) => hash && lane !== row.lane && <path key={`in-${lane}`} d={`M ${x(lane)} ${top} V ${middle}`} className={`graph-line graph-color-${lane % 6}`} />)}
        {row.lanesAfter.map((hash, lane) => hash && lane !== row.lane && <path key={`out-${lane}`} d={`M ${x(lane)} ${middle} V ${bottom}`} className={`graph-line graph-color-${lane % 6}`} />)}
        {row.lanesBefore[row.lane] && <path d={`M ${x(row.lane)} ${top} V ${middle}`} className={`graph-line graph-color-${row.lane % 6}`} />}
        {row.lanesAfter[row.lane] && <path d={`M ${x(row.lane)} ${middle} V ${bottom}`} className={`graph-line graph-color-${row.lane % 6}`} />}
        {row.secondary.map((edge, j) => <path key={`merge-${j}`} d={`M ${x(edge.from)} ${middle} C ${x(edge.from)} ${middle + 18} ${x(edge.to)} ${middle + 18} ${x(edge.to)} ${bottom}`} className={`graph-line graph-color-${edge.to % 6}`} />)}
        <circle cx={x(row.lane)} cy={middle} r={commits[i].parents.length > 1 ? 5 : 4} className={`graph-node graph-color-${row.lane % 6}`} />
      </g>;
    })}
  </svg></div>;
}
export function HistoryExplorer({ filesVisible, detailsVisible, onShowPanels, repo, branches, refresh, initialRef = 'HEAD', initialPath = '', initialCommit = '', workingBranch, onScopeChange, onContext }: Props) {
  const ref = initialRef;
  const [search, setSearch] = useState(''), [author, setAuthor] = useState(''), [path, setPath] = useState(initialPath);
  const [filters, setFilters] = useState(!!initialPath), [applied, setApplied] = useState({ ref: initialRef, q: '', author: '', path: initialPath });
  const [commits, setCommits] = useState<Commit[]>([]), [more, setMore] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState(initialCommit), [detail, setDetail] = useState<CommitDetail | null>(null), [comparison, setComparison] = useState<Comparison | null>(null);
  const [selectedFile, setSelectedFile] = useState(''), [collapsed, setCollapsed] = useState<Set<string>>(new Set()), [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(() => { setApplied({ref:initialRef,q:'',author:'',path:initialPath}); setPath(initialPath); setFilters(!!initialPath); setSearch(''); setAuthor(''); setSelected(initialCommit); }, [initialRef, initialPath, initialCommit]);
  useEffect(() => { const timer = setTimeout(() => setApplied({ ref, q: search, author, path }), 300); return () => clearTimeout(timer); }, [ref, search, author, path]);
  useEffect(() => {
    const controller = new AbortController(); generation.current++;
    setLoading(true); setError('');
    api<{commits: Commit[]; hasMore: boolean}>(`/repositories/${repo.id}/history?${query(applied)}`, { signal: controller.signal }).then(result => {
      setCommits(result.commits); setMore(result.hasMore);
      setSelected(previous => previous && ((previous === initialCommit && applied.ref === initialRef && !applied.q && !applied.author && applied.path === initialPath) || result.commits.some(commit => commit.hash === previous)) ? previous : result.commits[0]?.hash ?? '');
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setCommits([]); setMore(false); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repo.id, applied, refresh]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setComparison(null); setError('');
    if (selected) Promise.all([
      api<CommitDetail>(`/repositories/${repo.id}/commit?${query({ref:selected})}`, { signal: controller.signal }),
      api<Comparison>(`/repositories/${repo.id}/comparison?${query({scope:'commit',to:selected})}`, { signal: controller.signal }),
    ]).then(([commit, result]) => { setDetail(commit); setComparison(result); if (selected !== commit.hash) setSelected(commit.hash); setSelectedFile(previous => applied.path && result.files.some(file => file.path === applied.path) ? fileKey(result.files.find(file => file.path === applied.path)!) : result.files.some(file => fileKey(file) === previous) ? previous : fileKey(result.files[0] ?? {scope:'commit',path:''} as ChangedFile)); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [repo.id, selected, refresh, applied.path]);
  async function loadMore() {
    const version = generation.current; setLoading(true);
    try { const result = await api<{commits:Commit[];hasMore:boolean}>(`/repositories/${repo.id}/history?${query({...applied,offset:String(commits.length)})}`); if (version === generation.current) { setCommits(previous => [...previous, ...result.commits]); setMore(result.hasMore); } }
    catch (e) { if (version === generation.current) setError((e as Error).message); }
    finally { if (version === generation.current) setLoading(false); }
  }
  const file = comparison?.files.find(file => fileKey(file) === selectedFile) ?? comparison?.files[0];
  const knownRef = ['HEAD','all',...branches.map(branchRef)].includes(ref);
  const scopeName = ref === 'all' ? 'All branches & tags' : ref === 'HEAD' ? workingBranch || 'Current branch' : branches.find(branch => branchRef(branch) === ref)?.name ?? ref;
  const graphRows = commitGraph(commits);
  return <div className="history-workspace">
    <div className="history-searchbar"><label className="history-search"><Search size={15} /><input aria-label="Search commit history" placeholder="Search messages, descriptions, or commit ID…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>History</kbd></label><label className="history-scope"><GitBranch size={14}/><span>Browse</span><select aria-label="History scope" value={ref} onChange={e => onScopeChange(e.target.value)}><option value="HEAD">{workingBranch || "Current branch"} (working branch)</option><option value="all">All branches & tags</option>{!knownRef && <option value={ref}>{ref}</option>}<optgroup label="Local branches">{branches.filter(branch => !branch.remote).map(branch => <option key={branchRef(branch)} value={branchRef(branch)}>{branch.name}</option>)}</optgroup><optgroup label="Remote branches">{branches.filter(branch => branch.remote).map(branch => <option key={branchRef(branch)} value={branchRef(branch)}>{branch.name}</option>)}</optgroup></select></label><button className={`button small ${filters ? 'active' : ''}`} aria-expanded={filters} onClick={() => setFilters(!filters)}><Filter size={14} />Filters{author || path ? ' •' : ''}</button></div>
    {filters && <div className="history-filters"><label>Author<input aria-label="Filter history by author" value={author} onChange={e => setAuthor(e.target.value)} placeholder="Name or email" /></label><label>File path<input aria-label="Filter history by file path" value={path} onChange={e => setPath(e.target.value)} placeholder="src/example.ts (follows renames)" spellCheck={false} /></label><button className="icon-button" aria-label="Clear history filters" onClick={() => { setAuthor(''); setPath(''); setSearch(''); }}><X size={15}/></button></div>}
    <div className="history-browse-status"><span>Viewing <strong>{scopeName}</strong></span><span><GitBranch size={12}/>Working branch: <strong>{workingBranch || 'Detached HEAD'}</strong><small>History browsing leaves your working copy unchanged.</small></span></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className={`changes-layout history-content ${!detailsVisible ? 'files-only' : ''}`}>{filesVisible && <aside className="changes-sidebar"><div className="history-list"><div className="tree-toolbar"><span>{loading ? 'READING HISTORY…' : `${commits.length} COMMITS${more ? '+' : ''}`}</span><span className="history-graph-key"><GitMerge size={12}/>Merge paths</span></div><div className="history-scroll">{commits.length > 0 && <CommitGraph rows={graphRows} commits={commits}/>}<div className="history-commit-column">{commits.map(commit => <button key={commit.hash} className={`commit-row ${commit.hash === selected ? 'selected' : ''}`} onClick={() => setSelected(commit.hash)} onContextMenu={event => onContext(event,{commit})}><span className="commit-info"><strong>{commit.subject || 'Untitled commit'}</strong>{commit.refs?.length ? <span className="history-ref-list" title={commit.refs.join(', ')}>{commit.refs.slice(0,2).map(label=><em key={label}>{label}</em>)}{commit.refs.length > 2 && <em>+{commit.refs.length - 2}</em>}</span> : null}<span>{commit.author}<code>{commit.hash.slice(0,7)}</code></span>{commit.parents.length > 1 && <small className="merge-caption"><GitMerge size={11}/> Merged {commit.parents.length - 1} branch{commit.parents.length > 2 ? 'es' : ''} · {commit.parents.map(parent => parent.slice(0,7)).join(' + ')}</small>}<small>{new Date(commit.date).toLocaleDateString()}</small></span></button>)}{more && <button className="load-more" disabled={loading} onClick={() => void loadMore()}>Load older commits</button>}{!commits.length && !loading && <p className="tree-empty">No commits match this scope and search.</p>}</div></div></div>
      <FileTree onAction={async () => false} disabled={false} files={comparison?.files ?? []} selected={file ? fileKey(file) : ''} onSelect={file => setSelectedFile(fileKey(file))} collapsed={collapsed} onToggle={key => setCollapsed(previous => {const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next;})} prefix={`history:${repo.id}`} onContextMenu={(event,file) => onContext(event,{file})}/></aside>}
      {detailsVisible && <div className="detail-column">{detail && <div className="history-commit-detail"><div className="commit-detail-title"><GitCommitHorizontal size={16}/><strong>{detail.subject}</strong><button className="button small" title="Copy full commit ID" onClick={() => { void navigator.clipboard.writeText(detail.hash).then(() => {setCopied(true); setTimeout(() => setCopied(false),1500);}).catch(() => setError('Clipboard access was denied. Select and copy the commit ID below.')); }}><Copy size={12}/>{copied ? 'Copied' : detail.hash.slice(0,8)}</button></div><div className="commit-detail-meta"><span>{detail.author} &lt;{detail.email}&gt;</span><time>{new Date(detail.date).toLocaleString()}</time></div>{detail.decorations && <div className="commit-decorations">{detail.decorations}</div>}<details key={detail.hash}><summary>Commit details{detail.body ? ' & description' : ''}</summary><code className="full-commit-hash">{detail.hash}</code>{detail.body && <pre>{detail.body}</pre>}<p>Committer: {detail.committer} &lt;{detail.committerEmail}&gt; · {new Date(detail.committedDate).toLocaleString()}</p><p>{detail.parents.length > 1 ? 'Merge commit · diff against first parent' : detail.parents.length ? 'Diff against parent' : 'Initial commit'}</p>{detail.parents.map(parent=><code className="full-commit-hash" key={parent}>Parent: {parent}</code>)}</details></div>}
      {selected ? <DiffViewer variants={[]} onSelect={() => {}} clean={false} onChanged={() => {}} busy={false} repoId={repo.id} file={file} from={comparison?.from ?? undefined} to={comparison?.to} refresh={refresh}/> : <EmptyState title="Find the change behind the code" detail="Search commit messages, choose a branch, or filter by author and file."/>}</div>}
      {!filesVisible && !detailsVisible && <div className="panels-hidden"><button className="button" onClick={onShowPanels}>Open history panels</button></div>}
    </div>
  </div>;
}
