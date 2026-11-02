import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { PaletteCommand } from './CommandPalette';
export interface AppCommand extends PaletteCommand { menu:string; section?:string; checked?:boolean; danger?:boolean }
export function ApplicationMenu({commands}:{commands:AppCommand[]}) {
  const [open,setOpen]=useState('');const root=useRef<HTMLDivElement>(null);
  const names=['File','View','Repository','Working Copy','Help'];
  const menus=()=>[...root.current!.querySelectorAll<HTMLButtonElement>('.application-menu-popup button:not(:disabled)')];
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen('');};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  return <div ref={root} className="application-menu" onKeyDown={e=>{
    if(!open&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setOpen(document.activeElement?.getAttribute('data-menu')||'File');requestAnimationFrame(()=>menus()[0]?.focus());return;}
    if(e.key==='Escape'){e.preventDefault();root.current?.querySelector<HTMLButtonElement>(`[data-menu="${open}"]`)?.focus();setOpen('');}
    if(open&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const list=menus(),index=list.indexOf(document.activeElement as HTMLButtonElement);list[e.key==='Home'?0:e.key==='End'?list.length-1:(index+(e.key==='ArrowUp'?-1:1)+list.length)%list.length]?.focus();}
    if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const selected=open||document.activeElement?.getAttribute('data-menu')||'File',next=names[(names.indexOf(selected)+(e.key==='ArrowRight'?1:-1)+names.length)%names.length];if(open)setOpen(next);root.current?.querySelector<HTMLButtonElement>(`[data-menu="${next}"]`)?.focus();}
    if(e.key==='Tab')setOpen('');
  }}><nav role="menubar" aria-label="Application menu">{names.map(name=><button key={name} data-menu={name} role="menuitem" aria-haspopup="menu" aria-expanded={open===name} onMouseEnter={()=>{if(open)setOpen(name);}} onClick={()=>setOpen(open===name?'':name)}>{name}</button>)}</nav>
    {open&&<div className="application-menu-popup" role="menu" aria-label={`${open} menu`} style={{left:Math.min(names.indexOf(open)*52,window.innerWidth-320)}}>{commands.filter(command=>command.menu===open).map((command,index,list)=><button role={command.checked===undefined?'menuitem':'menuitemcheckbox'} aria-checked={command.checked} key={command.id} disabled={command.disabled} className={`${index&&command.section!==list[index-1].section?'menu-divider':''} ${command.danger?'danger-text':''}`} onClick={()=>{setOpen('');command.run();}}><span className="menu-check">{command.checked&&<Check size={14}/>}</span><span>{command.label}</span>{command.shortcut&&<kbd>{command.shortcut}</kbd>}</button>)}</div>}
  </div>;
}
