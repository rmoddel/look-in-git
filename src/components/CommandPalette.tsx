import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';

export interface PaletteCommand { id: string; label: string; group: string; detail?: string; shortcut?: string; disabled?: boolean; run: () => void }
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [search, setSearch] = useState(''), [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return commands.filter(item => terms.every(term => `${item.label} ${item.group} ${item.detail ?? ''}`.toLocaleLowerCase().includes(term))).slice(0, 60);
  }, [search, commands]);
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); return () => dialog.current?.close(); }, []);
  useEffect(() => { setActive(0); }, [search]);
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  function choose(command?: PaletteCommand) { if (command && !command.disabled) { onClose(); command.run(); } }
  return <dialog ref={dialog} className="command-palette" aria-label="Command palette" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(index => (index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length)); }
    if (e.key === 'Enter') { e.preventDefault(); choose(results[Math.min(active, results.length - 1)]); }
  }}>
    <div className="palette-search"><Search size={20} /><input ref={input} aria-label="Find a command, branch, or repository" placeholder="What would you like to do?" value={search} onChange={e => setSearch(e.target.value)} role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined} autoComplete="off" /><button className="icon-button" onClick={onClose} aria-label="Close command palette"><X size={17} /></button></div>
    <div id="palette-results" className="palette-results" role="listbox" aria-label="Commands">{results.map((command, index) => <button id={`command-${command.id}`} key={command.id} role="option" aria-selected={index === active} aria-disabled={command.disabled} className={index === active ? 'active' : ''} onMouseMove={() => setActive(index)} onClick={() => choose(command)}><span className="palette-group">{command.group}</span><span className="palette-command"><strong>{command.label}</strong>{command.detail && <small>{command.detail}</small>}</span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : <ArrowRight size={14} />}</button>)}{!results.length && <p className="tree-empty">No matching commands. Try a branch, repository, or action name.</p>}</div>
    <div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
  </dialog>;
}
