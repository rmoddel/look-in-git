import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import { AlignJustify, ChevronDown, ChevronRight, Columns2, FileCode2, FileQuestion, LoaderCircle, ShieldCheck, AlertCircle, Check, Braces, X } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import type { ChangedFile, DiffResult } from '../../shared/types';
import { api, query, readPreference, savePreference } from '../api';
import { usePreference } from '../preferences';
import { parsePatch, splitLines, type DiffLine } from '../diff-model';
import { Counts, displayPath, scopeLabels } from './FileTree';

for (const [name, language] of Object.entries({ javascript, typescript, css, xml, json, python, bash, csharp, markdown, yaml })) hljs.registerLanguage(name, language);
const languages: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', css: 'css', html: 'xml', svg: 'xml', json: 'json', py: 'python', sh: 'bash', cs: 'csharp', md: 'markdown', yml: 'yaml', yaml: 'yaml' };
const ROW = 24;
export function EmptyState({ title, detail, icon = 'file' }: { title: string; detail: string; icon?: 'file' | 'check' | 'shield' }) {
  return <div className="empty-state"><div className="empty-icon">{icon === 'check' ? <Check size={27} /> : icon === 'shield' ? <ShieldCheck size={27} /> : <FileCode2 size={27} />}</div><h3>{title}</h3><p>{detail}</p></div>;
}

export function DiffViewer({ repoId, file, variants, onSelect, from, to, refresh, clean, onChanged, busy: gitBusy }: { repoId: string; file?: ChangedFile; variants: ChangedFile[]; onSelect: (file: ChangedFile) => void; from?: string; to?: string; refresh: number; clean: boolean; onChanged: () => void; busy: boolean }) {
  const [mode, setMode] = usePreference<'inline' | 'split'>('diff-mode', 'inline');
  const [context] = usePreference('diff-context', 3);
  const [foldedFiles, setFoldedFiles] = useState<Set<string>>(() => new Set());
  const fileId = `${repoId}\0${file?.scope}\0${file?.path}`, folded = foldedFiles.has(fileId), bodyId = useId();
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [lineMenu, setLineMenu] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<number | null>(null), dragging = useRef(false);
  const lineMenuRef = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const rightViewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(''); setScroll(0); setSelection(new Set()); setActionError(''); setLineMenu(null); setConfirmDiscard(false); anchor.current = null;
    if (viewport.current) viewport.current.scrollTop = 0;
    if (!file) { setLoading(false); return; }
    setLoading(true);
    api<DiffResult>(`/repositories/${repoId}/diff?${query({ scope: file.scope, path: file.path, from, to, context:String(context) })}`, { signal: controller.signal })
      .then(setResult).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repoId, file?.path, file?.scope, from, to, refresh, context]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [result, mode]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    const close = (event: globalThis.MouseEvent) => { if (!lineMenuRef.current?.contains(event.target as Node)) setLineMenu(null); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setLineMenu(null); setSelection(new Set()); } };
    window.addEventListener('mouseup', up); document.addEventListener('click', close); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mouseup', up); document.removeEventListener('click', close); document.removeEventListener('keydown', escape); };
  }, []);
  const lines = useMemo(() => parsePatch(result?.patch ?? ''), [result]);
  const split = useMemo(() => splitLines(lines), [lines]);
  const language = languages[file?.path.split('.').pop()?.toLowerCase() ?? ''];
  const highlighted = useMemo(() => new Map(lines.map(line => [line, language && line.text.length < 3000 && ['add', 'delete', 'context'].includes(line.kind) ? hljs.highlight(line.text, { language, ignoreIllegals: true }).value : null])), [lines, language]);
  const total = mode === 'inline' ? lines.length : split.length;
  const start = Math.max(0, Math.floor(scroll / ROW) - 10);
  const end = Math.min(total, start + Math.ceil(height / ROW) + 24);
  const maxLength = useMemo(() => lines.reduce((max, line) => Math.max(max, line.text.length), 50), [lines]);
  const width = Math.min(24000, Math.max(600, maxLength * 7.9 + 130));
  const editable = !!result?.lineActions && !acting && !gitBusy;
  const changed = (line: DiffLine) => line.kind === 'add' || line.kind === 'delete';
  function range(to: number) { const from = anchor.current ?? to; return new Set(lines.filter(line => changed(line) && line.patchLine >= Math.min(from, to) && line.patchLine <= Math.max(from, to)).map(line => line.patchLine)); }
  function select(line: DiffLine, event: MouseEvent | KeyboardEvent) {
    if (!editable) return;
    if (event.shiftKey && anchor.current !== null) setSelection(range(line.patchLine));
    else { anchor.current = line.patchLine; setSelection(previous => { const next = event.ctrlKey || event.metaKey ? new Set(previous) : new Set<number>(); if (changed(line)) { if (next.has(line.patchLine)) next.delete(line.patchLine); else next.add(line.patchLine); } return next; }); }
  }
  const lineEvents = (line?: DiffLine) => !line || !result?.lineActions ? {} : {
    role: 'button', tabIndex: 0, 'aria-label': `Select ${line.kind === 'add' ? 'added' : line.kind === 'delete' ? 'removed' : 'context'} line ${line.next ?? line.old}`, 'aria-pressed': selection.has(line.patchLine),
    onMouseDown: (event: MouseEvent) => { if (event.button !== 0 || !editable) return; event.preventDefault(); select(line, event); dragging.current = true; },
    onMouseEnter: () => { if (dragging.current && editable) setSelection(range(line.patchLine)); },
    onKeyDown: (event: KeyboardEvent) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); select(line, event); } },
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (!editable) return; if (!selection.has(line.patchLine)) setSelection(changed(line) ? new Set([line.patchLine]) : new Set()); setLineMenu({ x: Math.min(event.clientX, window.innerWidth - 245), y: Math.min(event.clientY, window.innerHeight - 160) }); },
  };
  async function applyLines(action: 'stage' | 'unstage' | 'discard', confirmed = false) {
    if (!file || !result || !selection.size || !editable) return;
    setLineMenu(null);
    if (action === 'discard' && !confirmed) { setConfirmDiscard(true); return; }
    setActing(true); setActionError('');
    try {
      await api(`/repositories/${repoId}/lines`, { method: 'POST', body: JSON.stringify({ action, path: file.path, scope: file.scope, lines: [...selection], fingerprint: result.fingerprint, context, ...(confirmed ? { confirmed: true } : {}) }) });
      setConfirmDiscard(false); setSelection(new Set()); onChanged();
    } catch (error) { setActionError((error as Error).message); setConfirmDiscard(false); }
    finally { setActing(false); }
  }
  const renderText = (line: DiffLine) => highlighted.get(line) ? <span dangerouslySetInnerHTML={{ __html: highlighted.get(line)! }} /> : <span>{line.text}</span>;
  const half = (line: DiffLine | undefined, side: 'old' | 'next') => <div {...lineEvents(line)} className={`split-half ${line?.kind ?? 'blank'} ${line && selection.has(line.patchLine) ? 'selected-line' : ''}`}><span className="line-number">{line?.[side]}</span><span className="diff-sign">{line?.kind === 'add' ? '+' : line?.kind === 'delete' ? '−' : ' '}</span><code>{line && renderText(line)}</code></div>;
  if (!file) return <div className="diff-pane"><EmptyState title={clean ? 'Your working copy is clean' : 'A little context goes a long way.'} detail={clean ? 'There are no local changes to review. Everything is up to date with your last commit.' : 'Select a changed file to explore its diff.'} icon={clean ? 'check' : 'file'} /></div>;
  return <div className="diff-pane">
    <div className="diff-toolbar"><button className="diff-file-disclosure" aria-label={`${folded ? "Expand" : "Collapse"} diff for ${displayPath(file.path)}`} aria-expanded={!folded} aria-controls={bodyId} disabled={acting || confirmDiscard} onClick={() => setFoldedFiles(previous => { const next = new Set(previous); next.has(fileId) ? next.delete(fileId) : next.add(fileId); return next; })}>{folded ? <ChevronRight size={16}/> : <ChevronDown size={16}/>}<FileCode2 size={17}/><span className="diff-filename" title={displayPath(file.path)}>{displayPath(file.path)}</span></button><Counts file={file} /><div className="segmented" aria-label="Diff layout"><button title="Inline diff" aria-label="Inline diff" aria-pressed={mode === 'inline'} className={mode === 'inline' ? 'active' : ''} onClick={() => { setMode('inline'); savePreference('diff-mode', 'inline'); setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; }}><AlignJustify size={14} /><span>Inline</span></button><button title="Side-by-side diff" aria-label="Side-by-side diff" aria-pressed={mode === 'split'} className={mode === 'split' ? 'active' : ''} onClick={() => { setMode('split'); savePreference('diff-mode', 'split'); setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; }}><Columns2 size={14} /><span>Split</span></button></div></div>
    <div id={bodyId} className="diff-body" hidden={folded}>
    <div className="diff-context"><span className="context-dot" />{variants.length > 1 ? <span className="diff-scope-switch">{variants.map(variant => <button key={variant.scope} className={file.scope === variant.scope ? 'active' : ''} aria-pressed={file.scope === variant.scope} onClick={() => onSelect(variant)}>{scopeLabels[variant.scope]}</button>)}</span> : scopeLabels[file.scope]}<span className="muted">/</span><span>{file.scope === 'staged' ? 'HEAD → Index' : file.scope === 'unstaged' ? 'Index → Working copy' : file.scope === 'untracked' ? 'New file in working copy' : `${from?.slice(0, 7) || 'Empty tree'} → ${to?.slice(0, 7)}`}</span><span className="ml-auto flex items-center gap-1"><Braces size={12} />{language ?? 'Plain text'}</span></div>
    {file.oldPath && <div className="diff-notice">Renamed from <code>{displayPath(file.oldPath)}</code></div>}
    {result?.truncated && <div className="diff-notice"><AlertCircle size={14} />Large diff: showing the first 1 MiB or 12,000 lines. Full line totals remain in the file list when available.</div>}
    {result?.lineActions && <div className="line-actions"><span>{selection.size ? `${selection.size} change lines selected` : 'Drag lines or Shift-click to select'}</span>{selection.size > 0 && <button onClick={() => setSelection(new Set())} title="Clear line selection"><X size={13} /></button>}<button className="button small" disabled={!editable || !selection.size} onClick={() => void applyLines(file.scope === 'staged' ? 'unstage' : 'stage')}>{acting ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{file.scope === 'staged' ? 'Unstage' : 'Stage'} lines</button>{file.scope !== 'staged' && <button className="button small danger-text" disabled={!editable || !selection.size} onClick={() => void applyLines('discard')}>Discard lines…</button>}</div>}
    {actionError && <div className="error-banner" role="alert"><span>{actionError}</span><button onClick={() => setActionError('')} aria-label="Dismiss line action error"><X size={14} /></button></div>}
    {lineMenu && <div ref={lineMenuRef} className="context-menu line-context-menu" style={{ left: lineMenu.x, top: lineMenu.y }} role="menu"><button role="menuitem" disabled={!editable || !selection.size} onClick={() => void applyLines(file.scope === 'staged' ? 'unstage' : 'stage')}>{file.scope === 'staged' ? 'Unstage' : 'Stage'} selected lines</button>{file.scope !== 'staged' && <button role="menuitem" className="danger-text" disabled={!editable || !selection.size} onClick={() => void applyLines('discard')}>Discard selected lines…</button>}<button role="menuitem" onClick={() => { setSelection(new Set(lines.filter(changed).map(line => line.patchLine))); setLineMenu(null); }}>Select all changed lines</button></div>}
    {confirmDiscard && <DiscardLines count={selection.size} path={file.path} busy={acting} onClose={() => setConfirmDiscard(false)} onConfirm={() => void applyLines('discard', true)} />}
    {error ? <div className="inline-error"><AlertCircle size={20} /><strong>Couldn’t load this diff</strong><p>{error}</p></div> : loading ? <div className="loading-state"><LoaderCircle className="spin" size={22} /><span>Reading changes…</span></div> : result?.binary ? <div className="empty-state"><div className="empty-icon"><FileQuestion size={28} /></div><h3>Binary file changed</h3><p>{result.message}</p></div> : !lines.length ? <EmptyState title="No text to compare" detail={result?.message || 'Only file metadata changed, such as the path or file mode.'} /> : <>
      {mode === 'split' && <div className="split-labels"><span>Before</span><span>After</span></div>}
      {mode === 'split' ? <div className="split-viewport">{(['old', 'next'] as const).map(side => <div className="diff-scroll" key={side} ref={side === 'old' ? viewport : rightViewport} onScroll={e => { setScroll(e.currentTarget.scrollTop); const other = side === 'old' ? rightViewport.current : viewport.current; if (other && other.scrollTop !== e.currentTarget.scrollTop) other.scrollTop = e.currentTarget.scrollTop; }} tabIndex={0} role="region" aria-label={`${side === 'old' ? 'Before' : 'After'}: ${displayPath(file.path)}`}><div className="diff-canvas" style={{ height: total * ROW, minWidth: width }}><div style={{ transform: `translateY(${start * ROW}px)` }}>{split.slice(start, end).map((row, index) => <div key={start + index}>{row.header ? <div className={`diff-row ${row.header.kind}`}><code>{row.header.text}</code></div> : half(side === 'old' ? row.left : row.right, side)}</div>)}</div></div></div>)}</div> : <div className="diff-scroll" ref={viewport} onScroll={e => setScroll(e.currentTarget.scrollTop)} tabIndex={0} role="region" aria-label={`Diff for ${displayPath(file.path)}`}>
        <div className={`diff-canvas ${mode}`} style={{ height: total * ROW, minWidth: width }}>
          <div style={{ transform: `translateY(${start * ROW}px)` }}>
            {mode === 'inline' ? lines.slice(start, end).map((line, index) => line.kind === 'hunk' || line.kind === 'note' ? <div className={`diff-row ${line.kind}`} key={start + index}><code>{line.text}</code></div> : <div {...lineEvents(line)} className={`diff-row ${line.kind} ${selection.has(line.patchLine) ? 'selected-line' : ''}`} key={start + index}><span className="line-number">{line.old}</span><span className="line-number">{line.next}</span><span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}</span><code>{renderText(line)}</code></div>) : split.slice(start, end).map((row, index) => row.header ? <div className={`diff-row ${row.header.kind}`} key={start + index}><code>{row.header.text}</code></div> : <div className="split-row" key={start + index}>{half(row.left, 'old')}{half(row.right, 'next')}</div>)}
          </div>
        </div>
      </div>}
      <div className="diff-footer"><span>{lines.filter(l => l.kind === 'hunk').length} diff {lines.filter(l => l.kind === 'hunk').length === 1 ? 'hunk' : 'hunks'}</span><span>{result?.lineActions ? 'Ctrl-click to add separate lines to your selection' : 'Read-only preview'}</span></div>
    </>}
    </div>
  </div>;
}

function DiscardLines({ count, path, busy, onClose, onConfirm }: { count: number; path: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="open-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="discard-lines-title"><div className="dialog-heading"><AlertCircle size={28} className="danger-text" /><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Cancel discard"><X size={18} /></button></div><h2 id="discard-lines-title">Discard {count} selected change lines?</h2><p>This permanently removes these uncommitted edits from <strong>{displayPath(path)}</strong>. Added lines are deleted; removed lines are restored. Other changes stay as they are. Git cannot undo discarded edits unless you saved them in a commit or stash.</p><div className="dialog-actions"><button className="button" autoFocus disabled={busy} onClick={onClose}>Keep changes</button><button className="button danger-button" disabled={busy} onClick={onConfirm}>{busy ? 'Discarding…' : 'Discard selected changes'}</button></div></dialog>;
}
