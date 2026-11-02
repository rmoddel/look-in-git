import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GitCommitHorizontal, LoaderCircle, WandSparkles } from 'lucide-react';
import type { ActionRequest, ChangedFile } from '../../shared/types';
import { readPreference, savePreference } from '../api';

export function CommitComposer({ root, files, busy, pendingMerge, runAction }: { root: string; files: ChangedFile[]; busy: boolean; pendingMerge?: boolean; runAction: (body: ActionRequest) => Promise<boolean> }) {
  const [summary, setSummary] = useState(() => readPreference<{summary:string}>(`commit-draft:${root}`, {summary:''}).summary);
  const [description, setDescription] = useState(() => readPreference<{description:string}>(`commit-draft:${root}`, {description:''}).description);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { savePreference(`commit-draft:${root}`, {summary, description}); }, [root, summary, description]);
  const staged = files.filter(f => f.scope === 'staged');
  const labels: Record<string, string> = { A: 'Add', D: 'Remove', R: 'Rename', C: 'Copy', M: 'Update', T: 'Change file type of', U: 'Resolve' };
  function suggest() {
    setExpanded(true);
    if (!summary) setSummary(staged.length === 1 ? `${labels[staged[0].status] ?? 'Update'} ${staged[0].path.split('/').pop()}` : `Update ${staged.length} files`);
    setDescription(staged.map(file => `${labels[file.status] ?? 'Update'} ${file.path}${file.oldPath ? ` (from ${file.oldPath})` : ''}${file.binary ? ' — binary' : ` (+${file.added ?? '?'}/-${file.deleted ?? '?'})`}`).join('\n'));
  }
  return <form className="commit-composer" onSubmit={async e => { e.preventDefault(); if (await runAction({ action: 'commit', message: summary.trim() + (description.trim() ? '\n\n' + description.trim() : '') })) { setSummary(''); setDescription(''); } }}>
    <div className="composer-line"><GitCommitHorizontal size={16} /><span className="composer-staged">{staged.length} staged</span><label className="sr-only" htmlFor="commit-summary">Commit summary</label><input id="commit-summary" placeholder="Commit summary…" value={summary} onChange={e => setSummary(e.target.value)} required maxLength={250} disabled={busy} />
      <button type="button" className="description-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}Description{description && !expanded ? ' •' : ''}</button>
      <button type="button" className="description-helper" disabled={busy || !staged.length} onClick={suggest} title="Generate a local description from staged Git changes"><WandSparkles size={14} />Describe</button><button type="submit" className="button primary" disabled={busy || (!staged.length && !pendingMerge) || !summary.trim() || files.some(file => file.conflict)}>{busy ? <LoaderCircle size={14} className="spin" /> : <GitCommitHorizontal size={14} />}Commit</button>
    </div>
    {expanded && <div className="composer-description"><label className="sr-only" htmlFor="commit-description">Commit description</label><textarea id="commit-description" placeholder="Description (optional)" rows={2} value={description} onChange={e => setDescription(e.target.value)} disabled={busy} maxLength={9000} /></div>}
  </form>;
}
