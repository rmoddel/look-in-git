import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp, errorHandler } from '../server/app';
import { createFixture, fixtureGit, removeFixture, snapshot } from '../scripts/fixture';
import type { WorkflowInput, WorkflowReview } from '../shared/workflows';

const host='127.0.0.1:4317';
const {app}=createApp();app.use(errorHandler);
const cleanups:string[]=[];let token='';
beforeAll(async()=>{token=(await request(app).get('/api/session').set('Host',host)).body.token;});
afterAll(async()=>{for(const base of cleanups)await removeFixture(base);});
const get=(url:string)=>request(app).get(url).set('Host',host).set('X-Look-in-Git-Token',token);
const post=(url:string,body:unknown)=>request(app).post(url).set('Host',host).set('X-Look-in-Git-Token',token).send(body as object);
async function fixture(){const data=await createFixture();cleanups.push(data.base);const opened=await post('/api/repositories',{path:data.root});expect(opened.status).toBe(200);const prefix=`/api/repositories/${opened.body.id}`;return {...data,prefix,review:async(body:WorkflowInput)=>{const response=await post(`${prefix}/workflow/review`,body);expect(response.status,JSON.stringify(response.body)).toBe(200);return response.body as WorkflowReview;},execute:(body:WorkflowInput)=>post(`${prefix}/workflow`,body)};}

describe('reviewed workflows against disposable Git repositories',()=>{
  it('creates a tracked snapshot while preserving working files and index, and rejects a stale review',async()=>{
    const repo=await fixture(),before=await snapshot(repo.root),body:WorkflowInput={action:'snapshot',message:'Before layout experiment'};
    const review=await repo.review(body);expect(review.files.length).toBeGreaterThan(0);
    const result=await repo.execute({...body,fingerprint:review.fingerprint});expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(await fixtureGit(repo.root,['stash','list','--format=%gs'])).toContain('Before layout experiment');
    expect(await snapshot(repo.root)).not.toBe(before); // The stash ref changed, not the files/index.
    expect(await readFile(path.join(repo.root,'both.txt'),'utf8')).toBe('working\n');
    expect(await fixtureGit(repo.root,['diff','--cached','--name-only'])).toContain('both.txt');
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(409);
  });
  it('saves a recovery stash before discarding staged, unstaged, and untracked changes',async()=>{
    const repo=await fixture(),body:WorkflowInput={action:'discard-all'},review=await repo.review(body);
    const result=await repo.execute({...body,fingerprint:review.fingerprint});expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(await fixtureGit(repo.root,['status','--porcelain'])).toBe('');
    expect(await fixtureGit(repo.root,['stash','list','--format=%gs'])).toContain('Look-in-Git recovery before discard');
    await fixtureGit(repo.root,['stash','apply','--index','stash@{0}']);
    expect(await readFile(path.join(repo.root,'notes with spaces.txt'),'utf8')).toContain('Untracked note');
    expect(await fixtureGit(repo.root,['diff','--cached','--name-only'])).toContain('both.txt');
  });
  it('resets with a recovery branch, then amends with another recovery branch',async()=>{
    const repo=await fixture(),oldHead=await fixtureGit(repo.root,['rev-parse','HEAD']);
    const reset:WorkflowInput={action:'reset',target:repo.initial,mode:'soft'},review=await repo.review(reset);
    expect((await repo.execute({...reset,fingerprint:review.fingerprint})).status).toBe(200);
    expect(await fixtureGit(repo.root,['rev-parse','HEAD'])).toBe(repo.initial);
    expect(await fixtureGit(repo.root,['branch','--list','recovery/before-reset-*'])).toContain('recovery/before-reset-');
    expect(await fixtureGit(repo.root,['rev-parse','recovery/before-reset-*'])).not.toBe('');
    const amend:WorkflowInput={action:'amend',message:'Amended fixture snapshot'},amendReview=await repo.review(amend);
    expect((await repo.execute({...amend,fingerprint:amendReview.fingerprint})).status).toBe(200);
    expect(await fixtureGit(repo.root,['log','-1','--format=%s'])).toBe('Amended fixture snapshot');
    expect(await fixtureGit(repo.root,['branch','--list','recovery/before-amend-*'])).toContain('recovery/before-amend-');
    expect(oldHead).not.toBe(await fixtureGit(repo.root,['rev-parse','HEAD']));
  });
  it('creates a new branch worktree without changing the original checkout',async()=>{
    const repo=await fixture(),parent=repo.base,body:WorkflowInput={action:'worktree-create',parent,folder:'second-tree',name:'feature/worktree-test',target:'HEAD'},head=await fixtureGit(repo.root,['rev-parse','HEAD']);
    const review=await repo.review(body),result=await repo.execute({...body,fingerprint:review.fingerprint});expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(result.body.repository.root.toLowerCase()).toBe(path.join(parent,'second-tree').toLowerCase());
    expect(await fixtureGit(repo.root,['rev-parse','HEAD'])).toBe(head);
    expect(await fixtureGit(repo.root,['symbolic-ref','--short','HEAD'])).toBe('main');
    expect(await fixtureGit(result.body.repository.root,['symbolic-ref','--short','HEAD'])).toBe('feature/worktree-test');
    expect((await get(`${repo.prefix}/worktrees`)).body.some((tree:{branch:string})=>tree.branch==='feature/worktree-test')).toBe(true);
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(409);
  });
  it('imports only checked regular-file patches, rejects traversal and stale input',async()=>{
    const repo=await fixture();
    const patch='diff --git a/new-note.txt b/new-note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new-note.txt\n@@ -0,0 +1 @@\n+Hello patch\n';
    const body:WorkflowInput={action:'patch-apply',patch},review=await repo.review(body);
    expect(review.files).toEqual(['new-note.txt']);
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(200);
    expect(await readFile(path.join(repo.root,'new-note.txt'),'utf8')).toBe('Hello patch\n');
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(422);
    const traversal=patch.replaceAll('new-note.txt','../escape.txt');
    expect((await post(`${repo.prefix}/workflow/review`,{action:'patch-apply',patch:traversal})).status).toBeGreaterThanOrEqual(400);
    const link=patch.replace('100644','120000');
    expect((await post(`${repo.prefix}/workflow/review`,{action:'patch-apply',patch:link})).status).toBe(400);
    const exported=await get(`${repo.prefix}/patch?scope=unstaged`);expect(exported.status).toBe(200);expect(exported.body.patch).toContain('diff --git');
  });
  it('fetches a local bare remote, publishes one tag, and keeps diagnostics private',async()=>{
    const repo=await fixture(),remote=path.join(repo.base,'mirror.git');await mkdir(remote);await fixtureGit(remote,['init','--bare']);await fixtureGit(repo.root,['remote','add','mirror',remote]);
    const fetch:WorkflowInput={action:'fetch-all'},fetchReview=await repo.review(fetch);
    expect((await repo.execute({...fetch,fingerprint:fetchReview.fingerprint})).status).toBe(200);
    const tag:WorkflowInput={action:'tag-push',target:'v0.1.0',remote:'mirror'},tagReview=await repo.review(tag);
    expect((await repo.execute({...tag,fingerprint:tagReview.fingerprint})).status).toBe(200);
    expect(await fixtureGit(remote,['rev-parse','refs/tags/v0.1.0'])).toBe(repo.initial);
    const diagnostics=await get(`${repo.prefix}/diagnostics`);expect(diagnostics.status).toBe(200);
    expect(JSON.stringify(diagnostics.body)).not.toContain(repo.root);
    expect(JSON.stringify(diagnostics.body)).not.toContain(remote);
    expect(diagnostics.body.git).toMatch(/^git version/);
    expect((await post(`${repo.prefix}/launch`,{target:'arbitrary'})).status).toBe(400);
    await access(path.join(repo.root,'README.md'));
  });
  it('syncs only a clean branch with its configured upstream and refuses dirty work',async()=>{
    const repo=await fixture(),remote=path.join(repo.base,'sync.git');await mkdir(remote);await fixtureGit(remote,['init','--bare']);
    await fixtureGit(repo.root,['remote','add','origin',remote]);await fixtureGit(repo.root,['push','-u','origin','main']);
    expect((await post(`${repo.prefix}/workflow/review`,{action:'sync'})).status).toBe(409);
    await fixtureGit(repo.root,['stash','push','--include-untracked','-m','Before sync test']);
    await writeFile(path.join(repo.root,'sync.txt'),'sync test\n');await fixtureGit(repo.root,['add','sync.txt']);await fixtureGit(repo.root,['commit','-m','Local sync commit']);
    const body:WorkflowInput={action:'sync'},review=await repo.review(body);
    expect(review.title).toContain('origin/main');
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(200);
    expect(await fixtureGit(remote,['rev-parse','refs/heads/main'])).toBe(await fixtureGit(repo.root,['rev-parse','HEAD']));
    expect(await fixtureGit(repo.root,['stash','list','--format=%gs'])).toContain('Before sync test');
  });
  it('stashes dirty files before detached checkout, retaining branch and stash for recovery',async()=>{
    const repo=await fixture(),body:WorkflowInput={action:'checkout-revision',target:repo.initial},review=await repo.review(body);
    expect(review.detail).toContain('stash');
    expect((await repo.execute({...body,fingerprint:review.fingerprint})).status).toBe(200);
    expect(await fixtureGit(repo.root,['rev-parse','HEAD'])).toBe(repo.initial);
    expect(await fixtureGit(repo.root,['rev-parse','refs/heads/main'])).toBe(repo.latest);
    expect(await fixtureGit(repo.root,['stash','list','--format=%gs'])).toContain('before inspecting');
    expect(await fixtureGit(repo.root,['status','--porcelain'])).toBe('');
  });
});
