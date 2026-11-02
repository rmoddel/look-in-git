import { beforeEach, describe, expect, it, vi } from 'vitest';
const { gitMock } = vi.hoisted(() => ({ gitMock: vi.fn() }));
vi.mock('../server/git', () => ({ git: gitMock }));
import { credentialInput, credentialOptions, describeRemote, saveCredential } from '../server/credentials';
const ctx = { repo: { id: 'test', root: 'C:/fixture', name: 'Fixture' }, config: [], lockKey: 'C:/fixture/.git' };
beforeEach(() => {
  gitMock.mockReset();
  gitMock.mockImplementation(async (_root, operation, args) => ({ code: 0, truncated: false, output: operation === 'config' ? 'manager\n' : operation === 'remote' ? args.length ? 'https://user:embedded-secret@example.invalid/team/repo.git\n' : 'origin\n' : '' }));
});
describe('OS credential handoff (mocked vault; never stores test credentials)', () => {
  it('removes embedded userinfo and recognizes HTTPS, SSH and local remotes', () => {
    expect(describeRemote('origin', 'https://user:secret@example.invalid/team/repo.git')).toEqual({ name: 'origin', protocol: 'https', host: 'example.invalid', path: 'team/repo.git' });
    expect(describeRemote('origin', 'git@example.invalid:team/repo.git').protocol).toBe('ssh');
    expect(describeRemote('origin', 'C:\\repos\\repo.git').protocol).not.toBe('https');
  });
  it('rejects credential-protocol injection and non-HTTPS destinations', () => {
    const remote = describeRemote('origin', 'https://example.invalid/repo.git');
    expect(() => credentialInput(remote, 'user\nhost=evil', 'token')).toThrow();
    expect(() => credentialInput(remote, 'user', 'token\nprotocol=http')).toThrow();
    expect(() => credentialInput({ ...remote, protocol: 'http' }, 'user', 'token')).toThrow();
    expect(() => credentialInput({ ...remote, host: 'example.invalid\n' }, 'user', 'token')).toThrow();
  });
  it('passes secrets only on stdin and preserves the configured command-line helper', async () => {
    const options = await credentialOptions(ctx);
    expect(JSON.stringify(options)).not.toContain('embedded-secret');
    const saved = await saveCredential(ctx, { remote: 'origin', username: 'test-user', secret: 'test-only-secret' });
    expect(saved).toMatchObject({ saved: true, host: 'example.invalid' });
    expect(JSON.stringify(saved)).not.toContain('test-only-secret');
    const call = gitMock.mock.calls.find(([, op]) => op === 'credential')!;
    expect(call[2]).toEqual(['approve']);
    expect(call[3]).toMatchObject({ write: true, sensitive: true });
    expect(call[3].config).toBeUndefined();
    expect(call[3].input).toContain('\npassword=test-only-secret\n\n');
    expect(JSON.stringify(call.slice(0, 3))).not.toContain('test-only-secret');
  });
  it('rejects unknown remotes, extra fields and missing helpers without writing', async () => {
    await expect(saveCredential(ctx, { remote: 'other', username: 'user', secret: 'secret' })).rejects.toThrow('existing');
    await expect(saveCredential(ctx, { remote: 'origin', username: 'user', secret: 'secret', command: 'anything' })).rejects.toThrow();
    const existing = gitMock.getMockImplementation()!;
    gitMock.mockImplementation((root, operation, args) => operation === 'config' ? Promise.resolve({ code: 1, output: '', truncated: false }) : existing(root, operation, args));
    await expect(saveCredential(ctx, { remote: 'origin', username: 'user', secret: 'secret' })).rejects.toThrow('No Git credential helper');
    expect(gitMock.mock.calls.some(([, op]) => op === 'credential')).toBe(false);
  });
});
