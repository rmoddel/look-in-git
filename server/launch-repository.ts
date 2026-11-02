import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import type { Context } from './repositories.js';

export async function launchRepository(ctx:Context, value:unknown) {
  const body=value as {target?:unknown};
  if(!body||typeof body!=='object'||Object.keys(body).some(key=>key!=='target')||!['explorer','terminal'].includes(String(body.target)))throw new AppError(400,'INVALID_LAUNCH','Choose Explorer or Terminal.');
  if(process.platform!=='win32')throw new AppError(400,'WINDOWS_ONLY','Opening desktop applications is currently available on Windows.');
  const systemRoot=process.env.SystemRoot??'C:\\Windows';
  const executable=body.target==='explorer'?path.join(systemRoot,'explorer.exe'):path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  // The terminal is interactive at the user's explicit request. No commands or
  // scripts are passed; cwd is the revalidated repository root.
  const args=body.target==='explorer'?[ctx.repo.root]:['-NoLogo','-NoProfile','-NoExit'];
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:ctx.repo.root,shell:false,windowsHide:body.target!=='terminal',detached:true,stdio:'ignore'});
    child.once('spawn',()=>{child.unref();resolve();});child.once('error',()=>reject(new AppError(503,'LAUNCH_FAILED','Windows could not open that application.')));
  });
  return {output:`Opened ${body.target==='explorer'?'Explorer':'PowerShell'} in this repository.`};
}
