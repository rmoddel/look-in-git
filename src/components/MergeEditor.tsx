import { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronDown, GitMerge, LoaderCircle, Save } from 'lucide-react';
import type { MergeFile } from '../../shared/types';
import { api, query } from '../api';

export function MergeEditor({ repoId, path, onSaved }: { repoId: string; path: string; onSaved: () => void }) {
  const [file, setFile] = useState<MergeFile | null>(null);
  const [result, setResult] = useState('');
  const [showBase, setShowBase] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setFile(null); setError(''); setNotice('');
    api<MergeFile>(`/repositories/${repoId}/merge?${query({ path })}`, { signal: controller.signal }).then(data => { setFile(data); setResult(data.result); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [repoId, path, version]);
  async function save(stage: boolean) {
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await api<{ fingerprint: string }>(`/repositories/${repoId}/merge`, { method: 'POST', body: JSON.stringify({ path, content: result, fingerprint: file.fingerprint, indexFingerprint: file.indexFingerprint, stage }) });
      setFile({ ...file, fingerprint: response.fingerprint, result }); setNotice(stage ? 'Saved and staged. Complete the merge with a commit.' : 'Draft saved. This file is still marked as conflicted.');
      if (stage) onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function acceptConflict(side: 'ours' | 'theirs' | 'both') {
    const size = file?.markerSize ?? 7;
    const pattern = new RegExp(`^<{${size}}[^\\n]*\\n([\\s\\S]*?)^={${size}}[^\\n]*\\n([\\s\\S]*?)^>{${size}}[^\\n]*(?:\\n|$)`, 'gm');
    setResult(previous => previous.replace(pattern, (_all, ours: string, theirs: string) => {
      const local = ours.replace(new RegExp(`^\\|{${size}}[^\\n]*\\n[\\s\\S]*$`, 'm'), '');
      return side === 'ours' ? local : side === 'theirs' ? theirs : local + theirs;
    }));
  }
  const markerCount = file ? (result.match(new RegExp(`^<{${file.markerSize}} `, 'gm')) ?? []).length : 0;
  function source(label: string, value: string) { return <div className="merge-source"><div className="merge-source-header"><strong>{label}</strong><button disabled={busy} onClick={() => setResult(value)}>Use whole file</button></div><div className="merge-source-code">{value.split('\n').slice(0, 10000).map((line, index) => <div key={index}><span>{index + 1}</span><code>{line || ' '}</code></div>)}</div></div>; }
  return <div className="merge-editor"><div className="diff-toolbar"><GitMerge size={18} /><strong className="diff-filename">Resolve · {path}</strong><span className="merge-conflict-count">{markerCount} conflicts</span><button className="button small ml-auto" onClick={() => setShowBase(!showBase)}><ChevronDown size={13} />{showBase ? 'Hide base' : 'Show base'}</button></div>
    {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span><button onClick={() => setVersion(n => n + 1)}>Reload</button></div>}{notice && <div className="merge-notice" role="status"><Check size={15} />{notice}</div>}
    {!file ? !error && <div className="loading-state"><LoaderCircle size={22} className="spin" />Reading three-way merge…</div> : file.binary || file.missing ? <div className="empty-state"><AlertCircle size={26} /><h3>This conflict needs a dedicated Git tool</h3><p>Binary and deleted-file conflicts cannot be edited as text here.</p></div> : <>
      <div className={`merge-sources ${showBase ? 'with-base' : ''}`}>{showBase && source('BASE · common ancestor', file.base)}{source('OURS · index stage 2', file.ours)}{source('THEIRS · index stage 3', file.theirs)}</div>
      <div className="merge-result-heading"><strong>MERGED RESULT</strong><span>Resolve blocks:</span><button disabled={busy || !markerCount} onClick={() => acceptConflict('ours')}>Use ours</button><button disabled={busy || !markerCount} onClick={() => acceptConflict('theirs')}>Use theirs</button><button disabled={busy || !markerCount} onClick={() => acceptConflict('both')}>Use both</button></div>
      <textarea className="merge-result" aria-label="Merged file result" value={result} onChange={e => setResult(e.target.value)} spellCheck={false} disabled={busy} />
      <div className="merge-actions"><span>Edit freely. Your result is saved only when you click Save.</span><button className="button" disabled={busy} onClick={() => void save(false)}><Save size={14} />Save draft</button><button className="button primary" disabled={busy || markerCount > 0} onClick={() => void save(true)}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save & stage</button></div>
    </>}
  </div>;
}
