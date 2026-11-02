import { ArrowDown, ArrowDownToLine, ArrowUpFromLine, CircleAlert } from 'lucide-react';
import type { ActionReview } from '../../shared/types';

export function ActionReviewPanel({ review }: { review: ActionReview }) {
  return <section className="action-review" aria-label="Action preview" aria-live="polite">
    <div className="action-direction">
      <div><span>{review.sourceKind}</span><strong>{review.source || 'No branch selected'}</strong></div>
      <ArrowDown size={18} aria-hidden="true" />
      <div className="action-destination"><span>{review.destinationKind}</span><strong>{review.destination || 'No local branch'}</strong></div>
    </div>
    {!!review.remoteUrls.length && <div className="action-remote-address"><span>{review.action === 'push' ? 'Remote destination' : 'Remote source'}{review.remoteUrls.length > 1 ? 's (all)' : ''}</span>{review.remoteUrls.map((url, i) => <code key={i}>{url}</code>)}</div>}
    {review.incoming !== null && review.outgoing !== null ? <div className="action-commit-counts"><span><ArrowDownToLine size={13} />{review.incoming} incoming</span><span><ArrowUpFromLine size={13} />{review.outgoing} outgoing</span><small>{review.countsAreCached ? 'From local refs at the last fetch; the remote may have changed.' : 'Commits compared with your current branch.'}</small></div> : review.countsAreCached && <div className="action-count-note">No local tracking ref for this remote branch. Its existence and commit counts will be checked when Git connects.</div>}
    <p className="action-effect">{review.effect}</p>
    <ul className="action-effects">{review.details.map(detail => <li key={detail}>{detail}</li>)}</ul>
    {review.warnings.map(warning => <div className="action-warning" key={warning}><CircleAlert size={15} /><span>{warning}</span></div>)}
    {review.blocked && <div className="action-blocked" role="alert"><CircleAlert size={16} /><span>{review.blocked}</span></div>}
  </section>;
}
