import { useEffect, useState } from 'react';
import { readPreference, savePreference } from './api';

export function usePreference<T>(key:string,fallback:T):[T,(value:T)=>void] {
  const [value,setValue]=useState(()=>readPreference(key,fallback));
  useEffect(()=>{const update=()=>setValue(readPreference(key,fallback));window.addEventListener('look-in-git:preference',update);window.addEventListener('storage',update);return()=>{window.removeEventListener('look-in-git:preference',update);window.removeEventListener('storage',update);};},[key]);
  return [value,next=>savePreference(key,next)];
}
export function downloadText(name:string,text:string,type='text/plain') {
  const url=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
