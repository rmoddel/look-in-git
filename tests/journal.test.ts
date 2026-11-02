import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OperationJournal } from '../server/journal';
import { createApp, errorHandler } from '../server/app';
import { createFixture, removeFixture } from '../scripts/fixture';
import type { ActionResult, Repository } from '../shared/types';

const first: Repository = { id: 'first', name: 'First repository', root: 'unused-journal-metadata' };
const second: Repository = { id: 'second', name: 'Second repository', root: 'unused-journal-metadata' };
const ok: ActionResult = { command: ['git', 'status'], output: 'Completed.' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe('operation journal lifecycle and retention', () => {
  it('exposes in-flight operations, then records result, finish time and duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const journal = new OperationJournal(), work = deferred<ActionResult>();
    const tracked = journal.track(first, 'fetch', () => work.promise);
    const running = journal.list(first.id)[0];
    expect(running).toMatchObject({ repoId: first.id, repository: first.name, action: 'fetch', status: 'running', startedAt: '2026-01-01T12:00:00.000Z', commands: [], output: '' });
    expect(running.finishedAt).toBeUndefined();
    expect(running.durationMs).toBeUndefined();
    vi.setSystemTime(new Date('2026-01-01T12:00:02.500Z'));
    work.resolve(ok);
    expect(await tracked).toBe(ok);
    expect(journal.list(first.id)[0]).toMatchObject({ id: running.id, status: 'success', finishedAt: '2026-01-01T12:00:02.500Z', durationMs: 2500, commands: [['git', 'status']], output: 'Completed.' });
  });

  it('records a failed operation and rethrows the original error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const journal = new OperationJournal(), work = deferred<ActionResult>(), failure = new Error('Cannot merge: local changes.');
    const tracked = journal.track(first, 'merge', () => work.promise);
    const rejection = expect(tracked).rejects.toBe(failure);
    vi.setSystemTime(new Date('2026-01-01T12:00:00.025Z'));
    work.reject(failure);
    await rejection;
    expect(journal.list(first.id)[0]).toMatchObject({ status: 'error', durationMs: 25, finishedAt: '2026-01-01T12:00:00.025Z', output: failure.message });
  });

  it('isolates repository views and returns copies of command arrays', async () => {
    const journal = new OperationJournal();
    await journal.track(first, 'fetch', async () => ok);
    await journal.track(second, 'push', async () => ({ commands: [['git', 'fetch'], ['git', 'push']], output: 'Published.' }));
    expect(journal.list(first.id).map(entry => entry.action)).toEqual(['fetch']);
    expect(journal.list(second.id).map(entry => entry.action)).toEqual(['push']);
    expect(journal.list('unknown')).toEqual([]);
    const copy = journal.list(second.id);
    copy[0].commands[0][0] = 'tampered';
    copy[0].commands.push(['injected']);
    copy[0].output = 'Changed outside journal';
    expect(journal.list(second.id)[0]).toMatchObject({ commands: [['git', 'fetch'], ['git', 'push']], output: 'Published.' });
  });

  it('retains at most 100 completed operations across repository views immediately after completion', async () => {
    const journal = new OperationJournal();
    for (let index = 0; index < 130; index++) await journal.track(index % 2 ? first : second, `operation-${index}`, async () => ok);
    const entries = [...journal.list(first.id), ...journal.list(second.id)];
    expect(entries).toHaveLength(100);
    expect(entries.some(entry => entry.action === 'operation-29')).toBe(false);
    expect(entries.some(entry => entry.action === 'operation-30')).toBe(true);
    expect(entries.some(entry => entry.action === 'operation-129')).toBe(true);
  });

  it('keeps running operations during trimming, and trims completed batches when they settle', async () => {
    const journal = new OperationJournal(), pending = deferred<ActionResult>();
    const longRunning = journal.track(first, 'slow-fetch', () => pending.promise);
    for (let index = 0; index < 105; index++) await journal.track(second, `fast-${index}`, async () => ok);
    expect(journal.list(first.id)).toHaveLength(1);
    expect(journal.list(first.id)[0].status).toBe('running');
    const batch = Array.from({ length: 12 }, (_, index) => {
      const work = deferred<ActionResult>();
      return { work, tracked: journal.track(second, `batch-${index}`, () => work.promise) };
    });
    for (const { work } of batch) work.resolve(ok);
    await Promise.all(batch.map(item => item.tracked));
    expect(journal.list(second.id).filter(entry => entry.status !== 'running')).toHaveLength(100);
    expect(journal.list(first.id)[0].status).toBe('running');
    pending.resolve(ok); await longRunning;
    expect([...journal.list(first.id), ...journal.list(second.id)]).toHaveLength(100);
  });
});

describe('operation journal privacy', () => {
  it('never retains credential helper commands, output, summary, or failure details', async () => {
    const journal = new OperationJournal(), sensitive = 'credential-secret-must-never-appear';
    const result = { command: ['git', 'credential', sensitive], commands: [['git', 'credential', sensitive]], output: sensitive, summary: sensitive };
    expect(await journal.track(first, 'credentials', async () => result)).toBe(result);
    const failure = new Error(sensitive);
    await expect(journal.track(first, 'credentials', async () => { throw failure; })).rejects.toBe(failure);
    const entries = journal.list(first.id);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.commands.length === 0)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(sensitive);
    expect(entries[0].output).toBe('Credential helper handoff failed. Check the configured helper.');
    expect(entries[1].output).toBe('Credential helper handoff completed.');
  });

  it('redacts URL credentials and query tokens in commands, summaries, output and errors', async () => {
    const journal = new OperationJournal();
    const address = 'https://username:super-secret@example.invalid/team/project.git?access_token=query-secret#fragment-secret';
    await journal.track(first, 'push', async () => ({ command: ['git', 'push', address], summary: `Publishing to ${address}`, output: `Contacted ${address}\nAuthorization: Bearer bearer-secret\npassword=password-secret\ntoken=inline-secret` }));
    await expect(journal.track(first, 'fetch', async () => { throw new Error(`Failed for ${address}; client_secret=client-secret`); })).rejects.toThrow('Failed for');
    const serialized = JSON.stringify(journal.list(first.id));
    for (const secret of ['super-secret', 'query-secret', 'fragment-secret', 'bearer-secret', 'password-secret', 'inline-secret', 'client-secret']) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('https://example.invalid/team/project.git');
    expect(serialized).toContain('[redacted]');
  });

  it('bounds retained command arguments and output size', async () => {
    const journal = new OperationJournal();
    await journal.track(first, 'commit', async () => ({ command: ['git', 'commit', 'x'.repeat(5000)], output: 'y'.repeat(20000), summary: 'Done' }));
    const entry = journal.list(first.id)[0];
    expect(entry.commands[0][2]).toHaveLength(1000);
    expect(entry.output).toHaveLength(12000);
  });
});

it('journals API actions and credential failures for only their repository, without logging reads or request secrets', async () => {
  const fixture = await createFixture(true), other = await createFixture(true);
  try {
    const { app } = createApp(); app.use(errorHandler);
    const host = '127.0.0.1:4317', token = (await request(app).get('/api/session').set('Host', host)).body.token;
    const post = (url: string, body: object) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body);
    const get = (url: string) => request(app).get(url).set('Host', host).set('X-Look-in-Git-Token', token);
    const firstId = (await post('/api/repositories', { path: fixture.root })).body.id;
    const otherId = (await post('/api/repositories', { path: other.root })).body.id;
    await writeFile(path.join(fixture.root, 'README.md'), '# Journal fixture\n');
    expect((await post(`/api/repositories/${firstId}/actions`, { action: 'stage', path: 'README.md' })).status).toBe(200);
    expect((await get(`/api/repositories/${firstId}/working`)).status).toBe(200);
    const secret = 'api-credential-secret-never-log';
    expect((await post(`/api/repositories/${firstId}/credentials`, { remote: 'not-configured', username: secret, secret })).status).toBe(400);
    const response = await get(`/api/repositories/${firstId}/operations`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ action: 'credentials', status: 'error', commands: [] });
    expect(response.body[1]).toMatchObject({ action: 'stage', status: 'success' });
    expect(response.body[1].commands[0]).toContain('README.md');
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect((await get(`/api/repositories/${otherId}/operations`)).body).toEqual([]);
  } finally { await removeFixture(fixture.base); await removeFixture(other.base); }
});
