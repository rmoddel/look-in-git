import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { api } from '../src/api';
import { API_VERSION } from '../shared/protocol';
import { createApp, errorHandler } from '../server/app';

afterEach(() => vi.unstubAllGlobals());
it('gives restart instructions when new UI connects to an older server', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'test', repositories: [] }))));
  await expect(api('/session')).rejects.toMatchObject({ code: 'API_VERSION_MISMATCH', message: expect.stringContaining('npm.cmd start') });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'This API operation does not exist.' } }), { status: 404 })));
  await expect(api('/repositories/test/action-review?action=merge&target=HEAD')).rejects.toThrow('older server');
});
it('advertises its API version and rejects incompatible client versions', async () => {
  const { app } = createApp(); app.use(errorHandler);
  const session = await request(app).get('/api/session').set('Host', '127.0.0.1:4317');
  expect(session.body.apiVersion).toBe(API_VERSION);
  const result = await request(app).get('/api/repositories/missing/working').set('Host', '127.0.0.1:4317').set('X-Look-in-Git-Token', session.body.token).set('X-Look-in-Git-Api-Version', String(API_VERSION - 1));
  expect(result.body.error.code).toBe('API_VERSION_MISMATCH');
});
it('preserves stash recovery metadata in API errors', async () => {
  const saved = { ref: 'stash@{0}', hash: 'a'.repeat(40), subject: 'Saved work', date: '' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SWITCH_STASH_SAVED', message: 'Switch stopped', recovery: { stashed: saved } } }), { status: 422 })));
  await expect(api('/repositories/test/actions')).rejects.toMatchObject({ recovery: { stashed: saved } });
});
it('refuses a second startup before rebuilding when its port is already occupied', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(promisify(execFile)(process.execPath, ['scripts/start.mjs'], { windowsHide: true, shell: false, env: { ...process.env, LOOK_IN_GIT_PORT: String(port) } })).rejects.toMatchObject({ stderr: expect.stringContaining('Nothing was rebuilt.') });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
