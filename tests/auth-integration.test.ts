import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createFixture, fixtureGit, removeFixture } from '../scripts/fixture';
import { createApp, errorHandler } from '../server/app';

it('network actions reuse the repository-configured Git credential helper', async () => {
  const fixture = await createFixture();
  const marker = path.join(fixture.base, 'helper-invoked.txt');
  const helper = path.join(fixture.base, 'test-credential.cjs');
  // Test-only credentials, served only to our own loopback HTTP server.
  await writeFile(helper, `const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { if (process.argv[2] === 'get') { fs.writeFileSync(${JSON.stringify(marker)}, 'get'); process.stdout.write('username=fixture-user\\npassword=fixture-password\\n\\n'); } });`);
  const authorization: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization) { authorization.push(req.headers.authorization); res.writeHead(404); res.end('Fixture authentication reached; no real Git server.'); }
    else { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await fixtureGit(fixture.root, ['config', '--add', 'credential.helper', '']);
    await fixtureGit(fixture.root, ['config', '--add', 'credential.helper', `!"${process.execPath.replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`]);
    await fixtureGit(fixture.root, ['remote', 'add', 'origin', `http://127.0.0.1:${port}/fixture.git`]);
    const { app } = createApp(); app.use(errorHandler);
    const host = '127.0.0.1:4317';
    const token = (await request(app).get('/api/session').set('Host', host)).body.token;
    const post = (url: string, body: unknown) => request(app).post(url).set('Host', host).set('X-Look-in-Git-Token', token).send(body as object);
    const id = (await post('/api/repositories', { path: fixture.root })).body.id;
    const result = await post(`/api/repositories/${id}/actions`, { action: 'fetch', remote: 'origin' });
    expect(result.status).toBe(422); // Intentionally stops after successful test authentication.
    expect(await readFile(marker, 'utf8')).toBe('get');
    expect(authorization).toContain('Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64'));
    expect(JSON.stringify(result.body)).not.toContain('fixture-password');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await removeFixture(fixture.base); }
});
