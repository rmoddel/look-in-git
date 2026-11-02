import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeftRight, ArrowRight, Check, ChevronDown, ChevronRight, Circle, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, History, Laptop, LoaderCircle, LockKeyhole, Moon, Plus, RefreshCw, Search, ShieldCheck, Sun, X, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Columns3 } from 'lucide-react';
import type { ActionOptions, Branch, ChangedFile, Commit, Comparison, Repository, WorkingCopy, LicenseStatus } from '../shared/types';
import type { WorktreeInfo } from '../shared/worktrees';
import { branchRef } from '../shared/branches';
import { api, query, readPreference, savePreference, setToken } from './api';
import { Counts, FileTree, fileKey } from './components/FileTree';
import { DiffViewer, EmptyState } from './components/DiffViewer';
import { OpenRepository } from './components/OpenRepository';
import { useGitOperations } from './components/GitActions';
import { CommitComposer } from './components/CommitComposer';
import { MergeEditor } from './components/MergeEditor';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { HistoryExplorer } from './components/HistoryExplorer';
import { WorkspaceTools, type ToolsSection } from './components/WorkspaceTools';
import { LicensePanel } from './components/LicensePanel';
import { StashInspector } from './components/StashInspector';
import { RepositoryNavigation, SyncStatus } from './components/RepositoryNavigation';
import { GroupPicker, GroupManager } from './components/RepositoryGroups';
import { ALL_GROUPS, UNGROUPED, assignGroup, groupLabel, groupedRepositories, readGroups, repositoryGroup, type RepositoryGroups } from './repository-groups';
import { ApplicationMenu, type AppCommand } from './components/ApplicationMenu';
import { WorkflowDialog, workflowLabels, type WorkflowView } from './components/WorkflowDialog';
import { PreferencesPanel, HelpPanel } from './components/ProductPanels';
import { usePreference } from './preferences';
import { APP_VERSION } from '../shared/version';

type Tab = 'working' | 'history' | 'branches' | 'compare';
const tabs = [{ id: 'working', label: 'Working Changes', icon: FolderOpen }, { id: 'history', label: 'History', icon: History }, { id: 'branches', label: 'Branches', icon: GitBranch }, { id: 'compare', label: 'Compare', icon: ArrowLeftRight }] as const;
const formatDate = (date: string) => new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function initials(name: string) { return name.split(/[\s-_]+/).map(s => s[0]).join('').slice(0, 2).toUpperCase(); }

export default function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [groups, setGroups] = useState(() => readGroups(readPreference('repository-groups', null)));
  const [groupManager, setGroupManager] = useState<{draft:string}|null>(null);
  const [repoId, setRepoId] = useState('');
  const [tab, setTab] = useState<Tab>('working');
  const [working, setWorking] = useState<WorkingCopy | null>(null);
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [license,setLicense]=useState<LicenseStatus|null>(null),[showLicense,setShowLicense]=useState(false);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [openMode,setOpenMode]=useState<'open'|'clone'|'init'>('open');
  const [preferences,setPreferences]=useState(false),[help,setHelp]=useState<'guide'|'releases'|'about'|null>(null);
  const [workflow,setWorkflow]=useState<WorkflowView|null>(null);
  const [codeSize]=usePreference('code-size',13),[toolbarLabels]=usePreference('toolbar-labels',true);
  const [palette, setPalette] = useState(false);
  const [toolsSection, setToolsSection] = useState<ToolsSection | null>(null);
  const [stashHash, setStashHash] = useState('');
  const [historyTarget, setHistoryTarget] = useState({ref:'HEAD', path:'', commit:''});
  const [discoveryRoot, setDiscoveryRoot] = useState('');
  const [sidebar, setSidebar] = useState(() => readPreference('show-projects', true));
  const [filesPanel, setFilesPanel] = useState(() => readPreference('show-files', true));
  const [detailsPanel, setDetailsPanel] = useState(() => readPreference('show-details', true));
  const [dark, setDark] = useState(() => readPreference('dark', false));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState('');
  const [branchList, setBranchList] = useState<Branch[]>([]);
  const [navigation, setNavigation] = useState<ActionOptions | null>(null);
  const [activeWorktrees, setActiveWorktrees] = useState<WorktreeInfo[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareFrom, setCompareFrom] = useState('HEAD~1');
  const [compareTo, setCompareTo] = useState('HEAD');
  const [appliedCompare, setAppliedCompare] = useState<{ from: string; to: string } | null>(null);
  const currentRepoId = useRef(repoId);
  currentRepoId.current = repoId;
  const repo = repositories.find(r => r.id === repoId);
  const visibleRepositories = groupedRepositories(repositories, groups);
  const sameWorktreePath = (a: string, b: string) => a.replaceAll('\\','/').replace(/\/$/,'').toLowerCase() === b.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
  const mainWorktreePath = activeWorktrees.find(tree => tree.main)?.path;
  const pickerRepositories = activeWorktrees.length ? visibleRepositories.filter(item => !activeWorktrees.some(tree => sameWorktreePath(tree.path,item.root)) || sameWorktreePath(item.root,mainWorktreePath ?? '') || item.id === repoId) : visibleRepositories;
  const gitOps = useGitOperations(repo, changedRepoId => { if (!changedRepoId || currentRepoId.current === changedRepoId) setRefresh(n => n + 1); }, setError, switchedRepoId => { if (currentRepoId.current === switchedRepoId) setTab('working'); }, path => { setHistoryTarget({ref:'HEAD',path,commit:''}); setTab('history'); }, added => onOpen(added));

  useEffect(() => { savePreference('show-projects', sidebar); savePreference('show-files', filesPanel); savePreference('show-details', detailsPanel); }, [sidebar, filesPanel, detailsPanel]);
  useEffect(() => { savePreference('repository-groups', groups); }, [groups]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; savePreference('dark', dark); }, [dark]);
  useEffect(()=>{document.documentElement.style.setProperty('--diff-font-size',`${[12,13,14,15,16].includes(codeSize)?codeSize:13}px`);},[codeSize]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api<{ token: string; repositories: Repository[]; discoveryRoot: string; license: LicenseStatus }>('/session');
        setToken(session.token);
        setLicense(session.license);
        if(!session.license.allowed){setShowLicense(true);return;}
        const all = [...session.repositories];
        const remembered = readPreference<unknown>('repositories', []);
        if (Array.isArray(remembered)) for (const path of remembered.slice(0, 50)) {
          if (typeof path !== 'string' || all.some(r => r.root === path)) continue;
          try { all.push(await api<Repository>('/repositories', { method: 'POST', body: JSON.stringify({ path }) })); } catch { /* Removed repositories can be opened again by path. */ }
        }
        if (cancelled) return;
        setRepositories(all); setDiscoveryRoot(session.discoveryRoot);
        const previous = readPreference('active-root', '');
        const inGroup = groupedRepositories(all, groups);
        setRepoId(inGroup.find(r => r.root === previous)?.id ?? inGroup[0]?.id ?? '');
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setBooting(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (repo) savePreference('active-root', repo.root); document.title = `${repo?.name ?? groupLabel(groups)} — Look-in-Git`; }, [repo, groups]);
  useEffect(() => {
    if (!repoId) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    api<WorkingCopy>(`/repositories/${repoId}/working`, { signal: controller.signal }).then(setWorking)
      .catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repoId, refresh]);
  useEffect(() => {
    if (!repoId) return;
    const controller = new AbortController();
    api<ActionOptions>(`/repositories/${repoId}/action-options`, { signal: controller.signal }).then(result => { setNavigation(result); setBranchList(result.branches); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [repoId, refresh]);
  useEffect(() => {
    const isHistory = false;
    const isCompare = tab === 'compare' && appliedCompare;
    if (!repoId || (!isHistory && !isCompare)) { setComparison(null); return; }
    const controller = new AbortController();
    setComparison(null); setLoading(true); setError('');
    const params = isHistory ? { scope: 'commit', to: selectedCommit } : { scope: 'compare', ...appliedCompare! };
    api<Comparison>(`/repositories/${repoId}/comparison?${query(params)}`, { signal: controller.signal }).then(setComparison)
      .catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repoId, tab, selectedCommit, appliedCompare, refresh]);
  const activateRepo = useCallback((id: string) => {
    if (id === repoId) return;
    setRepoId(id); setActiveWorktrees([]); setTab('working'); setToolsSection(null); setStashHash(''); setHistoryTarget({ref:'HEAD',path:'',commit:''}); setWorking(null); setCommits([]); setSelectedCommit(''); setComparison(null); setAppliedCompare(null); setBranchList([]); setNavigation(null); setError('');
  }, [repoId]);
  function switchRepo(id: string) {
    const selected = repositories.find(item => item.id === id);
    if (selected && !visibleRepositories.some(item => item.id === id)) setGroups(previous => ({...previous,activeGroup:repositoryGroup(previous,selected.root)}));
    activateRepo(id);
  }
  function selectGroup(id: string) {
    if (gitOps.busy) return;
    const next = {...groups,activeGroup:id};
    const available = groupedRepositories(repositories,next);
    setGroups(next);
    activateRepo(available.find(item=>item.id===repoId)?.id ?? available[0]?.id ?? '');
  }
  function updateGroups(next: RepositoryGroups) {
    // Reclassifying the active project keeps its files on screen and follows
    // its new group; it never silently selects another working directory.
    if (repo && !groupedRepositories([repo],next).length) next = {...next,activeGroup:repositoryGroup(next,repo.root)};
    setGroups(next);
    if (!repo) activateRepo(groupedRepositories(repositories,next)[0]?.id ?? '');
  }
  const onOpen = (added: Repository, groupId?: string) => {
    setRepositories(previous => {
      const next = previous.some(r => r.id === added.id) ? previous : [...previous, added];
      savePreference('repositories', next.map(r => r.root));
      return next;
    });
    let next = groupId ? assignGroup(groups,added.root,groupId) : groups;
    if (!groupedRepositories([added],next).length) next={...next,activeGroup:repositoryGroup(next,added.root)};
    setGroups(next);
    activateRepo(added.id);
  };
  const files = tab === 'working' ? working?.files ?? [] : comparison?.files ?? [];
  const contextKey = `${repoId}:${tab}:${tab === 'history' ? selectedCommit : tab === 'compare' ? JSON.stringify(appliedCompare) : ''}`;
  const selected = files.find(f => fileKey(f) === selections[contextKey]) ?? files.find(f => f.path === selections[contextKey]?.split('\0')[1]) ?? files.find(f => f.scope === 'unstaged' && !f.binary && f.path.includes('/')) ?? files.find(f => !f.binary) ?? files[0];
  const selectFile = (file: ChangedFile) => setSelections(previous => ({ ...previous, [contextKey]: fileKey(file) }));
  useEffect(() => {
    if (selected) setSelections(previous => previous[contextKey] === fileKey(selected) ? previous : { ...previous, [contextKey]: fileKey(selected) });
  }, [contextKey, selected?.path, selected?.scope]);
  const totals = useMemo(() => ({ added: files.reduce((n, f) => n + (f.added ?? 0), 0), deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0), binary: false }), [files]);
  const unknownTotals = files.some(f => !f.binary && (f.added === null || f.deleted === null));
  const commit = commits.find(c => c.hash === selectedCommit);
  const inProgress = navigation?.rebaseInProgress ? 'rebase' : navigation?.cherryPickInProgress ? 'cherry-pick' : navigation?.revertInProgress ? 'revert' : navigation?.mergeInProgress ? 'merge' : null;
  async function moreHistory() {
    const id = repoId;
    setLoadingMore(true);
    try {
      const result = await api<{ commits: Commit[]; hasMore: boolean }>(`/repositories/${id}/history?offset=${commits.length}`);
      if (currentRepoId.current === id) { setCommits(previous => [...previous, ...result.commits]); setHasMore(result.hasMore); }
    } catch (e) { if (currentRepoId.current === id) setError((e as Error).message); }
    finally { setLoadingMore(false); }
  }
  function switchBranch(branch: Branch) {
    if (branch.remote) { setTab('working'); void gitOps.runAction({ action: 'switch', target: branchRef(branch), stashBeforeSwitch: true }); }
    else gitOps.openAction('switch', { target: branchRef(branch) });
  }
  function viewBranch(branch: Branch) { setHistoryTarget({ref:branchRef(branch),path:'',commit:''}); setFilesPanel(true); setDetailsPanel(true); setTab('history'); }
  function compareBranch(branch: Branch) { setCompareFrom('HEAD'); setCompareTo(branchRef(branch)); setAppliedCompare({ from: 'HEAD', to: branch.hash }); setTab('compare'); }

  useEffect(() => {
    if(!license || license.mode==='development')return;
    const refreshLicense=()=>{void api<LicenseStatus>('/license').then(value=>{setLicense(value);if(!value.allowed)setShowLicense(true);}).catch(()=>{});};
    const timer=setInterval(refreshLicense,60000);window.addEventListener('focus',refreshLicense);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refreshLicense);};
  },[license?.mode]);
  useEffect(() => {
    let last = 0;
    const refreshLocal = () => { if (!repoId || gitOps.busy || document.visibilityState !== 'visible' || document.querySelector('dialog[open]') || Date.now() - last < 2000) return; last = Date.now(); setRefresh(n => n + 1); };
    window.addEventListener('focus', refreshLocal); document.addEventListener('visibilitychange', refreshLocal);
    return () => {window.removeEventListener('focus', refreshLocal);document.removeEventListener('visibilitychange', refreshLocal);};
  }, [repoId, gitOps.busy]);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {event.preventDefault();setPreferences(true);return;}
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {event.preventDefault();if(event.shiftKey){setOpenMode('open');setOpen(true);}else setPalette(true);return;}
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'p'))) { event.preventDefault(); setPalette(true); }
      else if (event.altKey && ['1','2','3','4'].includes(event.key)) {event.preventDefault();setTab(tabs[Number(event.key)-1].id);}
      else if (event.key === 'F5' && !event.ctrlKey && !gitOps.busy) {event.preventDefault();setRefresh(n=>n+1);}
      else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && document.activeElement?.closest('.commit-composer')) {event.preventDefault(); const form=document.activeElement.closest('form');const submit=form?.querySelector<HTMLButtonElement>('button[type="submit"]');if(form instanceof HTMLFormElement && submit && !submit.disabled)form.requestSubmit(submit);}
    };
    window.addEventListener('keydown',shortcuts);return()=>window.removeEventListener('keydown',shortcuts);
  },[gitOps.busy]);
  const commands: PaletteCommand[] = [
    ...tabs.map((item,index)=>({id:`view-${item.id}`,label:item.label,group:'View',shortcut:`Alt+${index+1}`,run:()=>setTab(item.id)})),
    {id:'refresh',label:'Refresh working copy',group:'Workspace',shortcut:'F5',disabled:!repo||gitOps.busy,run:()=>setRefresh(n=>n+1)},
    {id:'open',label:'Open, clone, or create repository',group:'Workspace',run:()=>setOpen(true)},
    {id:'organize-groups',label:'Organize repository groups',group:'Workspace',detail:'Company, Personal, or any custom label',disabled:gitOps.busy,run:()=>setGroupManager({draft:''})},
    ...[{id:ALL_GROUPS,name:'All groups'},{id:UNGROUPED,name:'Ungrouped'},...groups.groups].map(group=>({id:`group-${group.id}`,label:group.name,group:'Repository group',detail:`${groupedRepositories(repositories,groups,group.id).length} repositories`,disabled:gitOps.busy,run:()=>selectGroup(group.id)})),
    {id:'commit',label:'Write a commit message',group:'Git',detail:'Commit staged changes; Ctrl+Enter submits from the composer',disabled:!repo,run:()=>{setTab('working');requestAnimationFrame(()=>document.getElementById('commit-summary')?.focus());}},
    ...(['fetch','pull','push','stash-save','merge','squash','rebase','branch-create'] as const).map(action=>({id:`action-${action}`,label:({fetch:'Fetch remote updates',pull:'Pull updates',push:'Push commits','stash-save':'Save a stash',merge:'Merge a branch',squash:'Squash merge',rebase:'Rebase current branch','branch-create':'Create a branch'})[action],group:'Git',detail:'Opens an action dialog',disabled:!repo||gitOps.busy,run:()=>gitOps.openAction(action)})),
    ...(['activity','recovery','remotes','tags'] as const).map(section=>({id:`tools-${section}`,label:({activity:'Operation history',recovery:'Reflog & recovery',remotes:'Remotes, tracking & branch names',tags:'Release tags'})[section],group:'Tools',disabled:!repo,run:()=>setToolsSection(section)})),
    ...branchList.map(branch=>({id:`branch-${branchRef(branch)}`,label:branch.name,group:branch.remote?'Remote branch':'Local branch',detail:'Inspect history without switching',run:()=>viewBranch(branch)})),
    ...pickerRepositories.map(item=>({id:`repo-${item.id}`,label:item.name,detail:`${groupLabel(groups,repositoryGroup(groups,item.root))} · ${item.root}`,group:'Repository',disabled:gitOps.busy,run:()=>switchRepo(item.id)})),
    {id:'theme',label:dark?'Use light theme':'Use dark theme',group:'Appearance',run:()=>setDark(!dark)},
    {id:'license',label:'License & activation',group:'Product',run:()=>setShowLicense(true)},
  ];

  const unavailable=!repo||gitOps.busy;
  const appCommand=(menu:string,id:string,label:string,run:()=>void,extra:Partial<AppCommand>={}):AppCommand=>({menu,id,label,group:menu,run,...extra});
  const actionCommand=(menu:string,action:Parameters<typeof gitOps.openAction>[0],label:string,section='git')=>appCommand(menu,`menu-${action}`,label,()=>gitOps.openAction(action),{disabled:unavailable,section});
  const workflowCommand=(menu:string,view:WorkflowView,section='tools')=>appCommand(menu,`workflow-${view}`,`${workflowLabels[view]}…`,()=>setWorkflow(view),{disabled:unavailable,section,danger:view==='discard-all'});
  const openRepository=(mode:'open'|'clone'|'init')=>{setOpenMode(mode);setOpen(true);};
  const launch=async(target:'explorer'|'terminal')=>{if(!repo)return;try{await api(`/repositories/${repo.id}/launch`,{method:'POST',body:JSON.stringify({target})});}catch(e){setError((e as Error).message);}};
  const applicationCommands:AppCommand[]=[
    appCommand('File','new-repository','New repository…',()=>openRepository('init'),{disabled:gitOps.busy,section:'open'}),
    appCommand('File','open-repository','Open local repository…',()=>openRepository('open'),{disabled:gitOps.busy,shortcut:'Ctrl+Shift+O',section:'open'}),
    appCommand('File','open-quickly','Open quickly / Quick actions…',()=>setPalette(true),{shortcut:'Ctrl+K',section:'open'}),
    appCommand('File','clone-repository','Clone repository…',()=>openRepository('clone'),{disabled:gitOps.busy,section:'open'}),
    appCommand('File','preferences','Preferences…',()=>setPreferences(true),{shortcut:'Ctrl+,',section:'settings'}),
    appCommand('File','groups','Organize repository groups…',()=>setGroupManager({draft:''}),{disabled:gitOps.busy,section:'settings'}),
    appCommand('File','credentials','Git credentials…',gitOps.openCredentials,{disabled:unavailable,section:'settings'}),
    appCommand('File','license-menu','License & activation…',()=>setShowLicense(true),{section:'settings'}),
    appCommand('File','explorer','Open in Explorer',()=>void launch('explorer'),{disabled:unavailable,section:'desktop'}),
    appCommand('File','terminal','Open in PowerShell',()=>void launch('terminal'),{disabled:unavailable,section:'desktop'}),
    ...tabs.map((item,index)=>appCommand('View',`menu-view-${item.id}`,item.label,()=>setTab(item.id),{shortcut:`Alt+${index+1}`,checked:tab===item.id,disabled:!repo,section:'views'})),
    appCommand('View','head-history','Show HEAD history',()=>{setHistoryTarget({ref:'HEAD',path:'',commit:''});setTab('history');},{disabled:!repo,section:'views'}),
    appCommand('View','view-recovery','Reflog & recovery…',()=>setToolsSection('recovery'),{disabled:!repo,section:'views'}),
    appCommand('View','sidebar','Sidebar',()=>setSidebar(!sidebar),{checked:sidebar,section:'panels'}),
    appCommand('View','files','Files panel',()=>setFilesPanel(!filesPanel),{checked:filesPanel,section:'panels'}),
    appCommand('View','details','Diff / details panel',()=>setDetailsPanel(!detailsPanel),{checked:detailsPanel,section:'panels'}),
    appCommand('View','restore-layout','Restore all panels',()=>{setSidebar(true);setFilesPanel(true);setDetailsPanel(true);},{section:'panels'}),
    appCommand('View','inline','Inline diffs',()=>savePreference('diff-mode','inline'),{section:'diffs'}),
    appCommand('View','split','Side-by-side diffs',()=>savePreference('diff-mode','split'),{section:'diffs'}),
    appCommand('View','diff-preferences','Diff font & context…',()=>setPreferences(true),{section:'diffs'}),
    appCommand('View','toolbar-labels','Show toolbar labels',()=>savePreference('toolbar-labels',!toolbarLabels),{checked:toolbarLabels,section:'appearance'}),
    appCommand('View','refresh-menu','Refresh',()=>setRefresh(n=>n+1),{disabled:unavailable,shortcut:'F5',section:'appearance'}),
    actionCommand('Repository','fetch','Fetch…'), workflowCommand('Repository','fetch-all','git'), actionCommand('Repository','pull','Pull updates…'),workflowCommand('Repository','sync','git'),actionCommand('Repository','push','Push / publish branch…'),workflowCommand('Repository','tag-push','git'),
    actionCommand('Repository','branch-create','Create new branch…','create'),appCommand('Repository','tags-menu','Tags / Create tag…',()=>setToolsSection('tags'),{disabled:unavailable,section:'create'}),appCommand('Repository','remotes-menu','Remotes / Add remote…',()=>setToolsSection('remotes'),{disabled:unavailable,section:'create'}),
    workflowCommand('Repository','worktree-create','create'),workflowCommand('Repository','worktrees','create'),
    appCommand('Repository','compare-menu','Compare revisions',()=>{setTab('compare');setFilesPanel(true);setDetailsPanel(true);},{disabled:!repo,section:'inspect'}),
    appCommand('Repository','embedded-diff','Open embedded diff',()=>{setTab('working');setDetailsPanel(true);},{disabled:!repo,section:'inspect'}),
    appCommand('Repository','activity-menu','Operation history…',()=>setToolsSection('activity'),{disabled:!repo,section:'inspect'}),
    workflowCommand('Working Copy','checkout-revision','git'),actionCommand('Working Copy','switch','Switch branch…'),actionCommand('Working Copy','merge','Merge…'),actionCommand('Working Copy','squash','Squash merge…'),actionCommand('Working Copy','rebase','Rebase…'),
    workflowCommand('Working Copy','patch-apply','patch'),workflowCommand('Working Copy','patch-export','patch'),
    actionCommand('Working Copy','stash-save','Save stash…','stash'),actionCommand('Working Copy','stash-apply','Apply stash…','stash'),actionCommand('Working Copy','stash-pop','Pop stash…','stash'),workflowCommand('Working Copy','snapshot','stash'),
    appCommand('Working Copy','write-commit','Commit…',()=>{setTab('working');requestAnimationFrame(()=>document.getElementById('commit-summary')?.focus());},{disabled:unavailable,section:'commit'}),
    workflowCommand('Working Copy','amend','commit'),
    appCommand('Working Copy','stage-all-menu','Stage all local changes',()=>void gitOps.runAction({action:'stage-all'}),{disabled:unavailable||!working?.files.some(file=>file.scope!=='staged'),section:'stage'}),
    appCommand('Working Copy','unstage-all-menu','Unstage all local changes',()=>void gitOps.runAction({action:'unstage-all'}),{disabled:unavailable||!working?.files.some(file=>file.scope==='staged'),section:'stage'}),
    workflowCommand('Working Copy','reset','recover'),workflowCommand('Working Copy','discard-all','recover'),
    appCommand('Help','guide','Quick guide & shortcuts…',()=>setHelp('guide'),{section:'help'}),appCommand('Help','releases','Release notes & updates…',()=>setHelp('releases'),{section:'help'}),
    appCommand('Help','diagnostics','Create diagnostic report…',()=>setHelp('about'),{section:'support'}),appCommand('Help','about','About Look-in-Git…',()=>setHelp('about'),{section:'support'}),
  ];

  return <div className={`app-shell ${toolbarLabels?'':'hide-toolbar-labels'}`}>
    <ApplicationMenu commands={applicationCommands}/>
    <header className="topbar">
      <div className="brand"><img src="/favicon.svg" alt="" /><span>Look-in-Git</span></div>
      <div className="top-divider" />
      <button className="icon-button sidebar-toggle" title={sidebar ? 'Hide sidebar' : 'Show sidebar'} aria-label={sidebar ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSidebar(!sidebar)}>{sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      <GroupPicker state={groups} repositories={repositories} disabled={gitOps.busy||booting} onSelect={selectGroup} onManage={(draft='')=>setGroupManager({draft})}/>
      <div className="repository-picker"><FolderGit2 size={17} /><select disabled={gitOps.busy||!pickerRepositories.length} aria-label="Active repository" value={repoId} onChange={e => switchRepo(e.target.value)}>{!pickerRepositories.length && <option value="">{groups.activeGroup===ALL_GROUPS?'Your local workspace':'No repositories'}</option>}{pickerRepositories.map(r => <option key={r.id} value={r.id} title={r.root}>{r.name}{activeWorktrees.some(tree=>sameWorktreePath(tree.path,r.root)&&!tree.main)?' · worktree':''}</option>)}</select><ChevronDown size={12} /></div><button className="icon-button" disabled={gitOps.busy} title="Add repository" aria-label="Add repository" onClick={() => setOpen(true)}><Plus size={16} /></button>
      {repo && <><span className="top-slash">/</span><span className="branch-badge" title={working?.branch}><GitBranch size={14} />{working?.branch ?? 'Reading branch…'}</span><SyncStatus working={working} /></>}
      {gitOps.toolbar}
      <button className="icon-button command-trigger" title="Find commands, branches, and repositories (Ctrl+K)" aria-label="Open command palette" onClick={()=>setPalette(true)}><Search size={17}/></button>
      <button className="icon-button" title="Repository activity" aria-label="Open repository activity" disabled={!repo} onClick={()=>setToolsSection('activity')}><Activity size={16}/></button>
      <div className="topbar-right"><div className="panel-toggles"><button className="icon-button" title={filesPanel ? 'Close files panel' : 'Open files panel'} aria-label={filesPanel ? 'Close files panel' : 'Open files panel'} aria-pressed={filesPanel} onClick={() => setFilesPanel(!filesPanel)}><Columns3 size={16} /></button><button className="icon-button" title={detailsPanel ? 'Close details panel' : 'Open details panel'} aria-label={detailsPanel ? 'Close details panel' : 'Open details panel'} aria-pressed={detailsPanel} onClick={() => setDetailsPanel(!detailsPanel)}>{detailsPanel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button><button className="reset-layout" onClick={() => { setSidebar(true); setFilesPanel(true); setDetailsPanel(true); }}>Reset layout</button></div><span className="local-label"><i />LOCAL APP</span><button className="icon-button" title={dark ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><button className="button refresh-button" disabled={!repo || loading} onClick={() => setRefresh(n => n + 1)} title="Refresh repository"><RefreshCw size={15} className={loading ? 'spin' : ''} /><span>Refresh</span></button></div>
    </header>
    <div className="workspace">
      {sidebar && <aside className="projects-sidebar">
        {repo ? <><div className="active-repository-heading" title={repo.root}><span className="project-avatar">{initials(repo.name)}</span><strong>{repo.name}</strong></div>
          <div className="repository-nav-scroll"><RepositoryNavigation key={repo.id} root={repo.root} repoId={repoId} working={working} options={navigation} active={tab === 'working'} view={tab} historyRef={historyTarget.ref} onView={setTab} onWorking={() => setTab('working')} onBranch={viewBranch} onSwitch={switchBranch} onMerge={target => gitOps.openAction('merge', { target })} onStash={stash => setStashHash(stash.hash)} onContext={gitOps.contextMenu} onTools={setToolsSection} onOpenWorktree={target=>onOpen(target,repositoryGroup(groups,repo.root))} onWorktreesChanged={()=>setRefresh(n=>n+1)} onWorktreesDiscovered={setActiveWorktrees} onCompareWorktree={branch=>{const from=working?.branch||'HEAD';setCompareFrom(from);setCompareTo(branch);setAppliedCompare({from,to:branch});setTab('compare');}} refresh={refresh}/></div></> : <p className="sidebar-empty">Choose a repository in the top bar to get started.</p>}
        <div className="sidebar-bottom"><span className="version">LOOK-IN-GIT <span>v{APP_VERSION}</span></span></div>
      </aside>}
      <main className="main-workspace" onContextMenu={event => gitOps.contextMenu(event)}>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
        {booting ? <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>Finding your local projects…</span></div> : !repo && groups.activeGroup !== ALL_GROUPS ? <div className="welcome group-empty"><div className="welcome-mark"><FolderGit2 size={30}/></div><h1>{groupLabel(groups)}</h1><p>No repositories in this group yet.<br/>Assign existing projects or open a repository here.</p><div><button className="button primary" onClick={()=>setGroupManager({draft:''})}>Organize repositories</button><button className="button" onClick={()=>setOpen(true)}><Plus size={16}/>Add repository</button></div><button className="group-back" onClick={()=>selectGroup(ALL_GROUPS)}>View all repositories</button></div> : !repo ? <div className="welcome"><div className="welcome-mark"><FolderGit2 size={34} /></div><span className="eyebrow">YOUR CODE. A CLEARER VIEW.</span><h1>Every change,<br />in perspective.</h1><p>A focused workspace for exploring your local Git repositories.<br />Start with your changes. Follow the details.</p><button className="button primary" onClick={() => setOpen(true)}><Plus size={17} />Open a repository<ArrowRight size={16} /></button><div className="welcome-foot"><ShieldCheck size={15} />Your repositories. One focused workspace.</div><p className="discovery-path">Auto-discovery: <code>{discoveryRoot || '~/code'}</code></p></div> : <>
          <div className="view-heading"><div><div className="breadcrumbs">{repo.name}<ChevronRight size={12} /><span>{tab === 'working' ? 'Working copy' : tab.charAt(0).toUpperCase() + tab.slice(1)}</span></div><h1>{tab === 'working' ? 'Working Changes' : tab === 'history' ? 'Commit History' : tab === 'branches' ? 'Branches' : 'Compare Revisions'}{loading && <LoaderCircle size={17} className="spin heading-loader" />}</h1></div>
            {(tab === 'working' || tab === 'compare') && <div className="change-summary"><span>{new Set(files.map(f => f.path)).size} changed {new Set(files.map(f => f.path)).size === 1 ? 'file' : 'files'}</span><Counts file={totals} />{unknownTotals && <span title="Some files have unknown line totals">+ more</span>}</div>}
          </div>
          {tab === 'working' && inProgress && <div className="in-progress"><span><strong>{inProgress === 'cherry-pick' ? 'Cherry-pick' : inProgress[0].toUpperCase() + inProgress.slice(1)} in progress.</strong> Resolve and stage any conflicts{inProgress === 'merge' ? ', then commit.' : ', then continue.'}</span>{inProgress !== 'merge' && <button className="button small" disabled={gitOps.busy} onClick={() => gitOps.openAction(`${inProgress}-continue`)}>Continue {inProgress}</button>}<button className="button small" disabled={gitOps.busy} onClick={() => gitOps.openAction(`${inProgress}-abort`)}>Abort {inProgress}</button></div>}
          {tab === 'working' && inProgress !== 'rebase' && inProgress !== 'cherry-pick' && inProgress !== 'revert' && <CommitComposer key={repoId} root={repo.root} pendingMerge={inProgress === 'merge'} files={working?.files ?? []} busy={gitOps.busy} runAction={gitOps.runAction} />}
          {tab === 'compare' && <form className="compare-form" onSubmit={e => { e.preventDefault(); setAppliedCompare({ from: compareFrom, to: compareTo }); }}><label><span>BASE</span><GitCommitHorizontal size={15} /><input aria-label="Base revision" list="branch-options" value={compareFrom} onChange={e => setCompareFrom(e.target.value)} placeholder="Branch or commit" required /></label><button type="button" className="icon-button" title="Swap revisions" aria-label="Swap revisions" onClick={() => { setCompareFrom(compareTo); setCompareTo(compareFrom); }}><ArrowLeftRight size={16} /></button><label><span>COMPARE</span><GitCommitHorizontal size={15} /><input aria-label="Target revision" list="branch-options" value={compareTo} onChange={e => setCompareTo(e.target.value)} placeholder="Branch or commit" required /></label><button className="button primary" disabled={loading} type="submit">Compare<ArrowRight size={15} /></button><datalist id="branch-options">{branchList.map(b => <option key={b.name} value={b.name} />)}</datalist></form>}
          {tab === 'history' ? <HistoryExplorer filesVisible={filesPanel} detailsVisible={detailsPanel} onShowPanels={()=>{setFilesPanel(true);setDetailsPanel(true);}} key={repo.id} repo={repo} branches={branchList} refresh={refresh} initialRef={historyTarget.ref} initialPath={historyTarget.path} initialCommit={historyTarget.commit} workingBranch={working?.branch ?? ""} onScopeChange={ref => setHistoryTarget({ref,path:"",commit:""})} onContext={gitOps.contextMenu}/> : tab === 'branches' ? <div className="branches-view"><div className="branches-intro"><span>{branchList.filter(b => !b.remote).length} local branches</span><span>Click a branch to browse its history. Remote refs reflect the last fetch.</span></div>{branchList.length === 0 ? <EmptyState title="No branches yet" detail="Stage files and create your first commit to see branches here." /> : <div className="branch-table"><div className="branch-table-head"><span>BRANCH</span><span>LATEST COMMIT</span><span>UPDATED</span><span /></div>{branchList.map(branch => <div className="branch-table-row" key={`${branch.remote}:${branch.name}`} onDoubleClick={() => { if (!branch.current) switchBranch(branch); }} onContextMenu={event => gitOps.contextMenu(event, { branch })} draggable onDragStart={event => { event.dataTransfer.setData('application/x-look-in-git-branch', JSON.stringify({ repoId, name: branchRef(branch) })); event.dataTransfer.effectAllowed = 'link'; }} onDragOver={event => { if (branch.current && event.dataTransfer.types.includes('application/x-look-in-git-branch')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); try { const source = JSON.parse(event.dataTransfer.getData('application/x-look-in-git-branch')); if (branch.current && source.repoId === repoId && source.name !== branchRef(branch)) gitOps.openAction('merge', { target: source.name }); } catch { /* Ignore unrelated drags. */ } }}><button className="branch-name branch-history-link" onClick={() => viewBranch(branch)} aria-label={`View history of ${branch.name}${branch.remote ? " (remote)" : ""}`} title="Browse commits without switching the working branch"><GitBranch size={17} /><span>{branch.name}</span>{branch.current && <span className="head-label">HEAD</span>}{branch.remote && <span className="remote-label">remote</span>}</button><button className="commit-link" onClick={() => viewBranch(branch)} title={branch.subject}><code>{branch.hash.slice(0, 7)}</code><span>{branch.subject}</span></button><time>{branch.date ? formatDate(branch.date) : '—'}</time><div className="branch-row-actions"><button className="button small" onClick={() => viewBranch(branch)} title="Browse this branch without checkout"><History size={13}/>History</button><button className="button small" onClick={() => compareBranch(branch)} title="Compare with the working branch"><ArrowLeftRight size={13}/>Compare</button></div></div>)}</div>}</div> : <div className={`changes-layout ${!detailsPanel ? 'files-only' : ''}`}>
            {filesPanel && <aside className="changes-sidebar">
              <FileTree key={`${repoId}:${tab}`} onContextMenu={(event, file, stagedFile) => gitOps.contextMenu(event, { file, stagedFile })} onAction={gitOps.runAction} disabled={gitOps.busy || loading} refreshError={error} files={files} selected={selected ? fileKey(selected) : ''} onSelect={selectFile} collapsed={collapsed} onToggle={key => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} prefix={`${repoId}:${tab}`} />
            </aside>}
            {detailsPanel && <div className="detail-column">
              {tab === 'compare' && !appliedCompare ? <EmptyState title="Two points. Every difference." detail="Enter two local branches, tags, or commit IDs to compare their file snapshots." /> : selected?.conflict ? <MergeEditor key={`${repoId}:${selected.path}`} repoId={repoId} path={selected.path} onSaved={() => setRefresh(n => n + 1)} /> : <DiffViewer variants={files.filter(file => file.path === selected?.path)} onSelect={selectFile} busy={gitOps.busy} onChanged={() => setRefresh(n => n + 1)} repoId={repoId} file={selected} from={comparison?.from ?? undefined} to={comparison?.to} refresh={refresh} clean={tab === 'working' && !!working && !files.length && !loading && !error} />}
            </div>}
            {!filesPanel && !detailsPanel && <div className="panels-hidden"><Columns3 size={30} /><h3>Your panels are tucked away.</h3><button className="button" onClick={() => { setFilesPanel(true); setDetailsPanel(true); }}>Open files & details</button></div>}
          </div>}
        </>}
      </main>
    </div>
    <footer className="statusbar"><span><span className="connection-dot" />{booting ? 'Connecting…' : 'Local workspace'}<span className="status-separator">/</span><span className="status-path" title={repo?.root}>{repo?.root || 'No repository selected'}</span></span><span>{license && license.mode !== 'development' && <button className="license-badge" onClick={()=>setShowLicense(true)}>{license.mode==='trial'?`Trial: ${license.daysRemaining} days`:license.mode==='licensed'?'Licensed':'Activate'}</button>}{working?.refreshedAt && <span className="refresh-time">Updated {new Date(working.refreshedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}<GitBranch size={12} />{gitOps.busy ? 'Running Git\u2026' : 'Git workspace'}</span></footer>
    {license && (showLicense || !license.allowed) && <LicensePanel status={license} onClose={license.allowed?()=>setShowLicense(false):undefined} onActivated={()=>window.location.reload()}/>}
    {gitOps.overlays}
    {palette && <CommandPalette commands={[...commands,...applicationCommands]} onClose={()=>setPalette(false)}/>}
    {preferences&&<PreferencesPanel dark={dark} onDark={setDark} sidebar={sidebar} files={filesPanel} details={detailsPanel} onPanels={(side,files,details)=>{setSidebar(side);setFilesPanel(files);setDetailsPanel(details);}} onClose={()=>setPreferences(false)}/>}
    {help&&<HelpPanel page={help} repo={repo} onClose={()=>setHelp(null)}/>}
    {repo&&workflow&&<WorkflowDialog key={`${repo.id}:${workflow}`} repo={repo} view={workflow} onClose={()=>setWorkflow(null)} onChanged={()=>setRefresh(n=>n+1)} onOpen={onOpen}/>}
    {repo && toolsSection && <WorkspaceTools key={repo.id} repo={repo} section={toolsSection} branches={branchList} onClose={()=>setToolsSection(null)} onChanged={()=>setRefresh(n=>n+1)} onInspect={hash=>{setHistoryTarget({ref:hash,path:'',commit:hash});setTab('history');}} onAction={gitOps.openAction}/>}
    {repo && stashHash && <StashInspector repo={repo} hash={stashHash} onClose={()=>setStashHash('')} onAction={gitOps.openAction}/>}
    {groupManager && <GroupManager state={groups} repositories={repositories} currentRoot={repo?.root} draft={groupManager.draft} onChange={updateGroups} onClose={()=>setGroupManager(null)}/>}
    {open && <OpenRepository initialMode={openMode} groups={groups.groups} defaultGroup={groups.groups.some(group=>group.id===groups.activeGroup)?groups.activeGroup:''} defaultPath={discoveryRoot} onClose={() => {setOpen(false);setOpenMode('open');}} onOpen={onOpen} />}
  </div>;
}
