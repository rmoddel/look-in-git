import express, { type ErrorRequestHandler } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Scope, LicenseStatus } from '../shared/types.js';
import { API_VERSION } from '../shared/protocol.js';
import { AppError } from './errors.js';
import { Repositories, discover } from './repositories.js';
import { stringValue } from './paths.js';
import * as service from './service.js';
import { actionOptions, executeAction } from './actions.js';
import { reviewAction } from './action-review.js';
import { credentialOptions, saveCredential } from './credentials.js';
import { mergeFile, saveMerge } from './merge.js';
import { lineAction } from './line-actions.js';
import { historySearch, commitDetails, reflogEntries, stashPreview } from './insights.js';
import { discardReview } from './discard-review.js';
import { createRepository, managementInfo, manageRepository } from './repository-tools.js';
import { OperationJournal } from './journal.js';
import { executeWorkflow, reviewWorkflow, exportPatch } from './workflows.js';
import { manageWorktree, worktrees } from './worktrees.js';
import { git } from './git.js';
import { launchRepository } from './launch-repository.js';
import { APP_VERSION } from '../shared/version.js';

export interface AppOptions { port?: number; repositories?: Repositories; discoveryRoot?: string; license?: {status:()=>Promise<LicenseStatus>;activate:(token:unknown)=>Promise<LicenseStatus>} }
const developmentLicense: LicenseStatus = {mode:'development',allowed:true,daysRemaining:null,expiresAt:null,deviceId:'',message:'Development build. Client release packages use a 30-day trial and signed licenses.'};
export function createApp(options: AppOptions = {}) {
  const app = express();
  const port = options.port ?? 4317;
  const origin = `http://127.0.0.1:${port}`;
  const repositories = options.repositories ?? new Repositories();
  const journal = new OperationJournal();
  const token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    const requestOrigin = `http://127.0.0.1:${port || req.socket.localPort}`;
    if (req.headers.host !== requestOrigin.slice('http://'.length)) return next(new AppError(403, 'INVALID_HOST', `Open Look-in-Git at ${requestOrigin}.`));
    if (req.headers.origin && req.headers.origin !== requestOrigin) return next(new AppError(403, 'INVALID_ORIGIN', 'This browser origin is not allowed.'));
    if (req.path.startsWith('/api') && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return next(new AppError(403, 'CROSS_SITE', 'Cross-site API requests are not allowed.'));
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.path === '/session' && req.method === 'GET') return next();
    const supplied = req.headers['x-look-in-git-token'];
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return next(new AppError(403, 'INVALID_TOKEN', 'Reload Look-in-Git to reconnect to the local server.'));
    next();
  });
  app.use('/api', (req, _res, next) => {
    const version = req.headers['x-look-in-git-api-version'];
    if (req.path !== '/session' && version !== undefined && version !== String(API_VERSION)) return next(new AppError(409, 'API_VERSION_MISMATCH', 'The Look-in-Git server was updated. Reload this page to load the matching interface.'));
    next();
  });
  app.use('/api', express.json({ limit: '2mb', strict: true }));
  app.use('/api', async (req, _res, next) => {
    if (!options.license || ['/session','/license','/license/activate'].includes(req.path)) return next();
    const status = await options.license.status();
    if (!status.allowed) throw new AppError(402, 'LICENSE_REQUIRED', status.message);
    next();
  });
  let inFlight = 0;
  app.use('/api', (_req, res, next) => {
    if (inFlight >= 16) return next(new AppError(429, 'BUSY', 'Too many requests. Please try again shortly.'));
    inFlight++;
    res.once('close', () => { inFlight--; });
    next();
  });
  app.get('/api/session', async (_req, res) => { const license = options.license ? await options.license.status() : developmentLicense; res.json({ token, apiVersion: API_VERSION, license, repositories: license.allowed ? repositories.list() : [], discoveryRoot: options.discoveryRoot ?? '' }); });
  app.get('/api/license', async (_req,res) => res.json(options.license ? await options.license.status() : developmentLicense));
  app.post('/api/license/activate', async (req,res) => { if(!options.license) throw new AppError(400,'DEVELOPMENT_BUILD','This development build does not require activation.'); if(!req.body || Object.keys(req.body).some(key=>key!=='key'))throw new AppError(400,'INVALID_INPUT','Provide a signed license key.');res.json(await options.license.activate(req.body.key)); });
  app.post('/api/repositories', async (req, res) => res.json(await repositories.open(req.body?.path)));
  app.post('/api/repositories/create', async (req, res) => res.json(await createRepository(repositories, req.body)));
  app.post('/api/discover', async (req, res) => res.json(await discover(req.body?.path)));
  app.get('/api/repositories/:id/working', async (req, res) => res.json(await service.working(await repositories.get(req.params.id))));
  app.get('/api/repositories/:id/action-review', async (req, res) => res.json(await reviewAction(await repositories.get(req.params.id), { action: req.query.action, target: req.query.target, remote: req.query.remote, remoteBranch: req.query.remoteBranch })));
  app.get('/api/repositories/:id/history', async (req, res) => {
    res.json(await historySearch(await repositories.get(req.params.id), req.query));
  });
  app.get('/api/repositories/:id/commit', async (req, res) => res.json(await commitDetails(await repositories.get(req.params.id), req.query.ref)));
  app.get('/api/repositories/:id/reflog', async (req, res) => res.json(await reflogEntries(await repositories.get(req.params.id), req.query.offset)));
  app.get('/api/repositories/:id/stash', async (req, res) => res.json(await stashPreview(await repositories.get(req.params.id), req.query.hash)));
  app.get('/api/repositories/:id/discard-review', async (req, res) => res.json(await discardReview(await repositories.get(req.params.id), req.query.path)));
  app.get('/api/repositories/:id/operations', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(journal.list(ctx.repo.id)); });
  app.get('/api/repositories/:id/tools', async (req, res) => res.json(await managementInfo(await repositories.get(req.params.id))));
  app.post('/api/repositories/:id/workflow/review', async (req,res)=>res.json(await reviewWorkflow(await repositories.get(req.params.id),req.body)));
  app.post('/api/repositories/:id/workflow', async (req,res)=>{const ctx=await repositories.get(req.params.id);res.json(await journal.track(ctx.repo,String(req.body?.action??'workflow').slice(0,40),()=>executeWorkflow(ctx,req.body,repositories)));});
  app.get('/api/repositories/:id/patch', async (req,res)=>res.json(await exportPatch(await repositories.get(req.params.id),req.query.scope,req.query.from,req.query.to)));
  app.get('/api/repositories/:id/worktrees', async (req,res)=>res.json(await worktrees(await repositories.get(req.params.id))));
  app.post('/api/repositories/:id/worktrees/action', async (req,res)=>{const ctx=await repositories.get(req.params.id);res.json(await journal.track(ctx.repo,`worktree ${String(req.body?.action??'action').slice(0,24)}`,()=>manageWorktree(ctx,req.body)));});
  app.post('/api/repositories/:id/launch', async (req,res)=>res.json(await launchRepository(await repositories.get(req.params.id),req.body)));
  app.get('/api/repositories/:id/diagnostics', async (req,res)=>{
    const ctx=await repositories.get(req.params.id), options=await actionOptions(ctx);
    const known=new Set(['credentials','Git action','repository settings','Save merge draft','Resolve and stage', 'stage lines','unstage lines','discard lines','patch-apply','snapshot','discard-all','reset','amend','worktree-create','fetch-all','tag-push','sync','checkout-revision',...['stage','unstage','stage-all','unstage-all','commit','stash-save','stash-apply','stash-pop','fetch','pull','push','merge','squash','rebase','switch','branch-create','branch-recover','branch-delete','rename','discard','cherry-pick','revert','merge-abort','rebase-abort','cherry-pick-abort','revert-abort','rebase-continue','cherry-pick-continue','revert-continue','remote-add','remote-set-url','remote-remove','tag-create','tag-delete','upstream-set','branch-rename','worktree create','worktree move','worktree lock','worktree unlock','worktree remove','worktree repair','worktree prune']]);
    res.json({product:'Look-in-Git',version:APP_VERSION,createdAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,git:(await git(ctx.repo.root,'--version',[])).output.trim(),apiVersion:API_VERSION,branches:options.branches.length,remotes:options.remotes.length,stashes:options.stashes.length,operations:journal.list(ctx.repo.id).map(({action,status,startedAt,durationMs})=>({action:known.has(action)?action:'other',status,startedAt,durationMs})),privacy:'No file contents, paths, remote addresses, author identities, command arguments, output, or credentials included.'});
  });
  app.post('/api/repositories/:id/tools', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(await journal.track(ctx.repo, typeof req.body?.action === 'string' ? req.body.action.slice(0, 40) : 'repository settings', () => manageRepository(ctx, req.body))); });
  app.get('/api/repositories/:id/branches', async (req, res) => res.json(await service.branches(await repositories.get(req.params.id))));
  app.get('/api/repositories/:id/action-options', async (req, res) => res.json(await actionOptions(await repositories.get(req.params.id))));
  app.post('/api/repositories/:id/actions', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(await journal.track(ctx.repo, typeof req.body?.action === 'string' ? req.body.action.slice(0, 40) : 'Git action', () => executeAction(ctx, req.body))); });
  app.post('/api/repositories/:id/lines', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(await journal.track(ctx.repo, `${String(req.body?.action).slice(0, 20)} lines`, () => lineAction(ctx, req.body))); });
  app.get('/api/repositories/:id/credentials', async (req, res) => res.json(await credentialOptions(await repositories.get(req.params.id))));
  app.post('/api/repositories/:id/credentials', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(await journal.track(ctx.repo, 'credentials', () => saveCredential(ctx, req.body))); });
  app.get('/api/repositories/:id/merge', async (req, res) => res.json(await mergeFile(await repositories.get(req.params.id), req.query.path)));
  app.post('/api/repositories/:id/merge', async (req, res) => { const ctx = await repositories.get(req.params.id); res.json(await journal.track(ctx.repo, req.body?.stage ? 'Resolve and stage' : 'Save merge draft', () => saveMerge(ctx, req.body))); });
  app.get('/api/repositories/:id/comparison', async (req, res) => {
    if (req.query.scope !== 'commit' && req.query.scope !== 'compare') throw new AppError(400, 'INVALID_SCOPE', 'Choose a commit or comparison.');
    res.json(await service.comparison(await repositories.get(req.params.id), req.query.scope, req.query.from, req.query.to));
  });
  app.get('/api/repositories/:id/diff', async (req, res) => {
    const scopes: Scope[] = ['unstaged', 'staged', 'untracked', 'commit', 'compare'];
    if (typeof req.query.scope !== 'string' || !scopes.includes(req.query.scope as Scope)) throw new AppError(400, 'INVALID_SCOPE', 'Invalid diff section.');
    res.json(await service.diff(await repositories.get(req.params.id), req.query.scope as Scope, stringValue(req.query.path, 'File path'), req.query.from, req.query.to, req.query.context ?? 3));
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'This API operation does not exist.')));
  return { app, repositories, origin };
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof AppError) res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) } });
  else if (error?.type === 'entity.parse.failed') res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request.' } });
  else if (error?.type === 'entity.too.large') res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'The request is too large.' } });
  else res.status(500).json({ error: { code: 'READ_FAILED', message: 'Unable to read this repository. Check folder permissions and refresh.' } });
};
