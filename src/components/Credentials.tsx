import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import type { Repository } from '../../shared/types';
import { api } from '../api';

interface CredentialOptions { remotes: { name: string; protocol: string; host: string; path: string; configured: boolean }[]; helper: string; store: string; available: boolean }
export function Credentials({ repo, onClose }: { repo: Repository; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<CredentialOptions | null>(null);
  const [remote, setRemote] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    dialog.current?.showModal(); const controller = new AbortController();
    api<CredentialOptions>(`/repositories/${repo.id}/credentials`, { signal: controller.signal }).then(result => { setOptions(result); setRemote(result.remotes.find(r => r.protocol === 'https')?.name ?? result.remotes[0]?.name ?? ''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [repo.id]);
  const selected = options?.remotes.find(r => r.name === remote);
  async function save() {
    setBusy(true); setError(''); setSaved('');
    try { const result = await api<{ store: string; host: string }>(`/repositories/${repo.id}/credentials`, { method: 'POST', body: JSON.stringify({ remote, username, secret }) }); setSecret(''); setSaved(`Passed to ${result.store} for ${result.host}. You can now fetch, pull, and push.`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="open-dialog action-dialog" onCancel={onClose} aria-labelledby="credentials-title"><div className="dialog-heading"><div className="dialog-icon"><KeyRound size={24} /></div><button className="icon-button" onClick={onClose} aria-label="Close credentials"><X size={19} /></button></div><h2 id="credentials-title">Git credentials</h2><p>{selected?.protocol === 'ssh' ? `Authentication for ${repo.name} is handled by your system SSH setup when Git connects.` : `Uses the same Git credential helper as your command line for ${repo.name}. Existing HTTPS credentials are reused automatically.`}</p>
    <form onSubmit={e => { e.preventDefault(); void save(); }}><label htmlFor="credential-remote">Repository remote</label><select id="credential-remote" value={remote} onChange={e => { setRemote(e.target.value); setSaved(''); }}>{!options?.remotes.length && <option value="">No remotes configured in this repository</option>}{options?.remotes.map(r => <option value={r.name} key={r.name}>{r.name} · {r.host} · {r.protocol.toUpperCase()}</option>)}</select>
      {selected?.protocol === 'https' ? <><label className="credential-label" htmlFor="credential-user">Git hosting username</label><input id="credential-user" value={username} onChange={e => setUsername(e.target.value)} required autoComplete="username" spellCheck={false} /><label className="credential-label" htmlFor="credential-secret">Personal access token / password</label><input id="credential-secret" type="password" value={secret} onChange={e => setSecret(e.target.value)} required autoComplete="off" spellCheck={false} maxLength={8000} /><div className="dialog-hint">For GitHub, use a personal access token with access to this repository. Your host’s token permissions still apply.</div><div className="credential-store"><ShieldCheck size={15} />{selected.configured ? 'Uses your configured Git credential helper; that helper controls storage.' : 'No credential helper is configured for this remote. Configure one in Git, then reopen this dialog.'}</div></> : selected?.protocol === 'ssh' ? <div className="credential-store"><KeyRound size={19} /><div><strong>SSH authentication uses your existing Git setup.</strong><p>Your SSH key and agent authenticate fetch, pull, and push. No username or token needs to be saved in Look-in-Git for this remote.</p><p>If Git asks you to unlock a key or trust the host, complete that through your usual Git terminal, then retry the action here.</p></div></div> : selected && <div className="credential-store">This remote does not use HTTPS credentials.</div>}
      {saved && <div className="credential-success" role="status"><Check size={17} />{saved}</div>}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Close</button>{selected?.protocol === 'https' && <button type="submit" className="button primary" disabled={busy || !selected?.configured || selected?.protocol !== 'https' || !username || !secret}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}Save credentials</button>}</div>
    </form></dialog>;
}
