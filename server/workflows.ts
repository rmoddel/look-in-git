import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { git } from './git.js';
import { AppError } from './errors.js';
import { actionOptions, withWriteLock } from './actions.js';
import { resolveRef } from './service.js';
import { parseNumstat, parseStatus } from './parsers.js';
import { readUntracked, stringValue, validateFilePath } from './paths.js';
import { folderName, localDirectory } from './repository-tools.js';
import { redactGitOutput } from './diagnostics.js';
import type { Context, Repositories } from './repositories.js';
import type { WorkflowInput, WorkflowKind, WorkflowReview } from '../shared/workflows.js';

const kinds: WorkflowKind[] = ['patch-apply','snapshot','discard-all','reset','amend','worktree-create','fetch-all','tag-push','sync','checkout-revision'];
const keys: Record<WorkflowKind,string[]> = {
  'patch-apply':['patch'], snapshot:['message'], 'discard-all':[], reset:['target','mode'], amend:['message'],
  'worktree-create':['parent','folder','name','target'], 'fetch-all':[], 'tag-push':['target','remote'],
  sync:[], 'checkout-revision':['target'],
};
function input(value: unknown): WorkflowInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400,'INVALID_INPUT','Provide a workflow.');
  const body = value as WorkflowInput;
  if (!kinds.includes(body.action) || Object.keys(body).some(key=>!['action','fingerprint',...keys[body.action]].includes(key))) throw new AppError(400,'INVALID_INPUT','Unknown workflow or parameter.');
  return body;
}
const read = (ctx:Context,op:string,args:string[],extra={}) => git(ctx.repo.root,op,args,{config:ctx.config,...extra});
const diffFlags=['--no-ext-diff','--no-textconv','--no-color','--binary','--full-index','--ignore-submodules=all'];

async function state(ctx:Context, includeUntrackedContent=false) {
  const [status, staged, unstaged, head, stashHead, options] = await Promise.all([
    read(ctx,'status',['--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']),
    read(ctx,'diff',[...diffFlags,'--cached','--']), read(ctx,'diff',[...diffFlags,'--']),
    read(ctx,'rev-parse',['--verify','HEAD'],{acceptedCodes:[128,1]}),
    read(ctx,'rev-parse',['--verify','refs/stash'],{acceptedCodes:[128,1]}), actionOptions(ctx),
  ]);
  if(options.mergeInProgress||options.rebaseInProgress||options.cherryPickInProgress||options.revertInProgress) throw new AppError(409,'OPERATION_IN_PROGRESS','Finish or abort the current Git operation first.');
  const entries=parseStatus(status.output);
  if(entries.some(entry=>entry.conflict)) throw new AppError(409,'UNRESOLVED_CONFLICTS','Resolve conflicts before using this workflow.');
  const digest=createHash('sha256').update(head.output).update(stashHead.output).update(options.branch).update(status.output).update(staged.output).update(unstaged.output);
  for(const entry of entries) {
    await validateFilePath(ctx.repo.root,entry.path);
    if(entry.oldPath)await validateFilePath(ctx.repo.root,entry.oldPath);
    if(entry.index==='?' && includeUntrackedContent) {
      const data=await readUntracked(ctx.repo.root,entry.path);
      digest.update(data.data);
      if(data.large){const info=await lstat(path.join(ctx.repo.root,...entry.path.split('/')));digest.update(`${info.size}:${info.mtimeMs}:${info.ino}`);}
    }
  }
  return {head:head.code===0?head.output.trim():'',entries,options,fingerprint:digest.digest('hex')};
}

async function patchPaths(ctx:Context,value:unknown) {
  const patch=stringValue(value,'Patch',1024*1024);
  // New links/gitlinks can change how later paths resolve. This importer accepts
  // regular-file patches only; Git still performs its own path and hunk checks.
  if(/^(?:(?:new|old|deleted) (?:file )?mode (?:120000|160000)|index .* (?:120000|160000))\r?$/m.test(patch)) throw new AppError(400,'PATCH_FILE_TYPE','Patch import supports regular files only, not symlinks or submodules.');
  const result=await read(ctx,'apply',['--numstat','-z','-'],{input:patch});
  const files=parseNumstat(result.output);
  if(!files.length || files.length>500)throw new AppError(400,'PATCH_LIMIT','Choose a patch containing between 1 and 500 files.');
  for(const file of files) {
    await validateFilePath(ctx.repo.root,file.path);
    if(file.oldPath)await validateFilePath(ctx.repo.root,file.oldPath);
  }
  await read(ctx,'apply',['--check','--whitespace=nowarn','-'],{input:patch});
  return files.map(file=>file.path);
}

export async function reviewWorkflow(ctx:Context,value:unknown):Promise<WorkflowReview> {
  const body=input(value);
  const current=await state(ctx,body.action==='discard-all');
  let files=current.entries.map(entry=>entry.path), target='', extra='', title='',detail='';
  if(body.action==='patch-apply') {
    files=await patchPaths(ctx,body.patch); title='Apply patch to working files'; detail='Applies every reviewed hunk together. Changes remain unstaged; the index is unchanged.';
  } else if(body.action==='snapshot') {
    if(!current.head || !current.entries.some(entry=>entry.index!=='?'))throw new AppError(409,'NOTHING_TO_SAVE','A snapshot needs a commit and tracked changes. Use Save stash with untracked files for new files.');
    files=current.entries.filter(entry=>entry.index!=='?').map(entry=>entry.path);
    title='Save a snapshot without cleaning your files'; detail='Saves tracked staged and unstaged changes as a named stash. Your working files and staging stay in place. Untracked and ignored files are not included.';
  } else if(body.action==='discard-all') {
    if(!current.head || !files.length)throw new AppError(409,'NOTHING_TO_SAVE','There are no changes to save and discard, or the repository has no initial commit.');
    title='Save recovery stash and discard local changes'; detail='Moves all staged, unstaged, and untracked changes into a recovery stash, then cleans those changes from the working copy. Ignored files stay. Reapply the stash from the sidebar to recover your work.';
  } else if(body.action==='reset') {
    if(!['soft','mixed'].includes(body.mode??''))throw new AppError(400,'INVALID_MODE','Choose soft or mixed reset.');
    if(!current.options.branch)throw new AppError(409,'DETACHED_HEAD','Switch to a local branch before resetting.');
    target=await resolveRef(ctx,body.target); title=`Reset ${current.options.branch} to ${target.slice(0,8)}`;
    detail=`Creates a recovery branch at the current commit, then moves ${current.options.branch}. ${body.mode==='soft'?'Keeps the index and working files unchanged.':'Keeps working files, but replaces the index with the target commit (unstages changes).'} Nothing is pushed. Published commits will require coordination with your team.`;
  } else if(body.action==='amend') {
    if(!current.head)throw new AppError(409,'NO_COMMIT','Make an initial commit first.');
    if(!stringValue(body.message,'Commit message',10000).trim())throw new AppError(400,'INVALID_MESSAGE','Enter a commit message.');
    title=`Replace latest commit ${current.head.slice(0,8)}`; detail='Includes the current staged changes and replaces the message; unstaged files stay. Creates a recovery branch first. Amending changes the commit ID. Do not amend a shared commit without coordinating with collaborators.';
  } else if(body.action==='worktree-create') {
    const parent=await localDirectory(body.parent), folder=folderName(body.folder), name=stringValue(body.name,'New branch name',250);
    const within=path.relative(ctx.repo.root,parent);
    if(!within||within!== '..'&&!within.startsWith('..'+path.sep)&&!path.isAbsolute(within))throw new AppError(400,'INVALID_PARENT','Create the new worktree beside or outside the current repository, not inside it.');
    if(name.startsWith('-')||name.startsWith('refs/')||name==='HEAD'||(await read(ctx,'check-ref-format',[`refs/heads/${name}`],{acceptedCodes:[1,128]})).code!==0)throw new AppError(400,'INVALID_BRANCH','Enter a valid new branch name.');
    if(current.options.branches.some(branch=>!branch.remote&&branch.name===name))throw new AppError(409,'BRANCH_EXISTS','Choose a new branch name for this worktree.');
    const destination=path.join(parent,folder);
    try {await lstat(destination);throw new AppError(409,'DESTINATION_EXISTS','The new worktree folder must not exist.');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    target=await resolveRef(ctx,body.target); extra=destination;files=[];
    title=`Create worktree on ${name}`; detail=`Creates ${destination} at ${target.slice(0,8)}, on a new branch. Shares Git history and remotes, with its own working files and index. Opens it when complete.`;
  } else if(body.action==='fetch-all') {
    if(!current.options.remotes.length)throw new AppError(409,'NO_REMOTE','Add a remote first.');
    extra=JSON.stringify(await Promise.all(current.options.remotes.map(async remote=>[remote,(await read(ctx,'remote',['get-url','--all',remote])).output])));
    files=[];title='Fetch every configured remote';detail=`Downloads refs and objects from ${current.options.remotes.join(', ')} using your system Git credentials. Working files and local branches stay in place. Stops and reports if a remote fails.`;
  } else if(body.action==='tag-push') {
    const remote=stringValue(body.remote,'Remote',100), tag=stringValue(body.target,'Tag',250);
    if(remote.startsWith('-')||!current.options.remotes.includes(remote)||tag.startsWith('-')||tag.startsWith('refs/')||(await read(ctx,'check-ref-format',[`refs/tags/${tag}`],{acceptedCodes:[1,128]})).code!==0)throw new AppError(400,'INVALID_TARGET','Choose a configured remote and a local tag.');
    target=(await read(ctx,'rev-parse',['--verify','--end-of-options',`refs/tags/${tag}`])).output.trim();
    extra=(await read(ctx,'remote',['get-url','--push','--all',remote])).output;
    files=[];title=`Publish tag ${tag} to ${remote}`;detail='Pushes only this tag, including its annotation if present. Existing remote tags are never overwritten. Branches are not pushed.';
  } else if(body.action==='sync') {
    const upstream=current.options.upstream;
    if(!current.options.branch||!upstream||!current.options.remotes.includes(upstream.remote))throw new AppError(409,'NO_UPSTREAM','Set a valid upstream for the current local branch before syncing.');
    if(files.length)throw new AppError(409,'DIRTY_WORKTREE','Commit or stash your local changes before syncing. Sync requires a clean working copy.');
    const branch=await read(ctx,'check-ref-format',[`refs/heads/${upstream.branch}`],{acceptedCodes:[1,128]});
    if(branch.code!==0)throw new AppError(409,'INVALID_UPSTREAM','The upstream branch name is invalid.');
    const tracking=`refs/remotes/${upstream.remote}/${upstream.branch}`;
    const [fetchUrl,pushUrl,trackingTip]=await Promise.all([read(ctx,'remote',['get-url','--all',upstream.remote]),read(ctx,'remote',['get-url','--push','--all',upstream.remote]),read(ctx,'rev-parse',['--verify','--end-of-options',`${tracking}^{commit}`],{acceptedCodes:[1,128]})]);
    const counts=trackingTip.code===0?(await read(ctx,'rev-list',['--left-right','--count',`HEAD...${tracking}`,'--'])).output.trim().split(/\s+/).map(Number):null;
    extra=JSON.stringify({upstream,fetchUrl:fetchUrl.output,pushUrl:pushUrl.output,tracking:trackingTip.output});files=[];
    title=`Sync ${current.options.branch} with ${upstream.remote}/${upstream.branch}`;
    detail=`${counts?`Last fetched state: ↑ ${counts[0]} outgoing, ↓ ${counts[1]} incoming. `:'No previously fetched upstream tip is available. '}Fetches the upstream, fast-forwards this local branch, then pushes local commits to that exact upstream. The working copy must be clean. If the histories diverge, sync stops before pushing; merge or rebase explicitly. Never force-pushes.`;
  } else if(body.action==='checkout-revision') {
    target=await resolveRef(ctx,body.target);
    title=`Inspect revision ${target.slice(0,8)} in the working copy`;
    detail=files.length?'Saves staged, unstaged, and untracked changes in a named stash, then checks out this commit in detached HEAD. The stash stays in the sidebar for explicit reapplication. Your current branch is not moved. If checkout fails, the stash stays available.':'Checks out this commit in detached HEAD. The current branch and its commits are not moved. Switch back to a branch when finished.';
  }
  return {fingerprint:createHash('sha256').update(JSON.stringify({...body,fingerprint:undefined})).update(current.fingerprint).update(target).update(extra).digest('hex'),title,detail,files,head:current.head,...(target?{target}:{})};
}

export async function executeWorkflow(ctx:Context,value:unknown,registry:Repositories) {
  const body=input(value);
  return withWriteLock(ctx.lockKey,async()=>{
    const review=await reviewWorkflow(ctx,body);
    if(!body.fingerprint||review.fingerprint!==body.fingerprint)throw new AppError(409,'REVIEW_CHANGED','The request or repository changed. Review the current action before running it.');
    const commands:string[][]=[], outputs:string[]=[];
    const run=async(op:string,args:string[],extra={})=>{commands.push(['git',op,...args]);const result=await git(ctx.repo.root,op,args,{write:true,...extra});outputs.push(result.output);return result.output.trim();};
    let repository;
    if(body.action==='patch-apply')await run('apply',['--whitespace=nowarn','-'],{input:body.patch});
    else if(body.action==='snapshot') {
      const hash=await run('stash',['create']);
      if(!/^[a-f0-9]{40,64}$/.test(hash))throw new AppError(409,'NOTHING_TO_SAVE','No tracked changes remain.');
      await run('stash',['store','-m',stringValue(body.message||'Look-in-Git snapshot','Snapshot name',1000),hash]);
    } else if(body.action==='discard-all')await run('stash',['push','--include-untracked','-m',`Look-in-Git recovery before discard ${new Date().toISOString()}`]);
    else if(body.action==='reset'||body.action==='amend') {
      const backup=`recovery/before-${body.action}-${Date.now()}-${randomBytes(3).toString('hex')}`;
      await run('branch',['--',backup,review.head]);
      if(body.action==='reset')await run('reset',[body.mode==='soft'?'--soft':'--mixed',review.target!,'--']);
      else await run('commit',['--amend','--no-gpg-sign','-m',body.message!]);
      outputs.push(`Previous commit preserved on ${backup}.`);
    } else if(body.action==='worktree-create') {
      const parent=await localDirectory(body.parent), destination=path.join(parent,folderName(body.folder));
      await mkdir(destination); // atomic no-overwrite reservation
      await run('worktree',['add','--no-track','-b',body.name!,destination,review.target!]);
      repository=await registry.open(destination);
    } else if(body.action==='fetch-all') {
      for(const remote of (await actionOptions(ctx)).remotes)await run('fetch',['--no-recurse-submodules','--',remote],{network:true});
    } else if(body.action==='tag-push')await run('push',['--porcelain','--no-follow-tags','--recurse-submodules=no','--signed=false','--',body.remote!,`refs/tags/${body.target}:refs/tags/${body.target}`],{network:true});
    else if(body.action==='sync') {
      const upstream=(await actionOptions(ctx)).upstream!;
      await run('fetch',['--no-recurse-submodules','--',upstream.remote],{network:true});
      await run('pull',['--ff-only','--no-rebase','--no-autostash','--no-recurse-submodules','--',upstream.remote,`refs/heads/${upstream.branch}`],{network:true});
      await run('push',['--porcelain','--no-follow-tags','--recurse-submodules=no','--signed=false','--',upstream.remote,`HEAD:refs/heads/${upstream.branch}`],{network:true});
    } else if(body.action==='checkout-revision') {
      if(review.files.length) {
        await run('stash',['push','--include-untracked','-m',`Look-in-Git: before inspecting ${review.target!.slice(0,8)}`]);
        outputs.push('Local changes saved in a stash. Reapply it explicitly from Stashes after switching.');
      }
      try{await run('switch',['--detach',review.target!]);}
      catch(error){throw new AppError(422,'CHECKOUT_FAILED',`Checkout failed. ${review.files.length?'Your local changes remain saved in Stashes. ':''}${(error as Error).message}`);}
    }
    return {command:commands[0],commands:commands.map(args=>args.map(redactGitOutput)),output:redactGitOutput(outputs.filter(Boolean).join('\n'))||'Completed successfully.',summary:review.title,...(repository?{repository}:{})};
  });
}

export async function exportPatch(ctx:Context,scope:unknown,from:unknown,to:unknown) {
  if(!['staged','unstaged','compare'].includes(String(scope)))throw new AppError(400,'INVALID_SCOPE','Choose staged, unstaged, or two revisions.');
  const args=scope==='compare'?[await resolveRef(ctx,from),await resolveRef(ctx,to)]:scope==='staged'?['--cached']:[];
  return {patch:(await read(ctx,'diff',[...diffFlags,...args,'--'],{limit:1024*1024})).output};
}
