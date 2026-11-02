import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rename, unlink, readFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const fixturesRoot = path.join(process.cwd(), 'artifacts', 'fixtures');
export async function fixtureGit(root: string, args: string[]) {
  // Mutating Git commands exist only in this test helper and only within fixtures.
  const relative = path.relative(fixturesRoot, await realpath(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture Git must stay in the temporary fixture directory.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return (await execute('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { shell: false, windowsHide: true, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' })).stdout.trim();
}
export async function createFixture(empty = false) {
  await mkdir(fixturesRoot, { recursive: true });
  const base = await mkdtemp(path.join(fixturesRoot, 'look-in-git-'));
  const root = path.join(base, 'fieldnotes');
  await mkdir(root);
  await fixtureGit(root, ['init', '-b', 'main']);
  await fixtureGit(root, ['config', 'user.name', 'Alex Morgan']);
  await fixtureGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fixtureGit(root, ['config', 'core.autocrlf', 'false']);
  if (empty) return { base, root, initial: '', latest: '' };
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await mkdir(path.join(root, 'src', 'styles'), { recursive: true });
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'README.md'), '# Fieldnotes\n\nA calmer place to collect your ideas.\n');
  await writeFile(path.join(root, 'src', 'App.tsx'), `import { Sidebar } from './components/Sidebar';\n\nexport function App() {\n  const title = 'Your notes';\n\n  return (\n    <main className="workspace">\n      <Sidebar />\n      <section>\n        <h1>{title}</h1>\n        <p>Everything you need, in one place.</p>\n      </section>\n    </main>\n  );\n}\n`);
  await writeFile(path.join(root, 'src', 'components', 'Sidebar.tsx'), "export function Sidebar() {\n  return <aside>Your workspace</aside>;\n}\n");
  await writeFile(path.join(root, 'src', 'styles', 'theme.css'), ':root {\n  --accent: #4f74c8;\n  --background: #fff;\n}\n');
  await writeFile(path.join(root, 'docs', 'old-guide.md'), '# Getting started\n\nWelcome to Fieldnotes.\n');
  await writeFile(path.join(root, 'legacy.config.json'), '{"theme":"classic"}\n');
  await writeFile(path.join(root, 'both.txt'), 'original\n');
  await writeFile(path.join(root, 'literal[1].txt'), 'literal original\n');
  await writeFile(path.join(root, 'literal1.txt'), 'other original\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fixtureGit(root, ['add', '--all']);
  await fixtureGit(root, ['commit', '-m', 'Create the Fieldnotes workspace']);
  const initial = await fixtureGit(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'README.md'), '# Fieldnotes\n\nA calmer place to collect your ideas.\n\nMade for focused work.\n');
  await fixtureGit(root, ['add', '--', 'README.md']);
  await fixtureGit(root, ['commit', '-m', 'Introduce the workspace and getting started guide']);
  const latest = await fixtureGit(root, ['rev-parse', 'HEAD']);
  await fixtureGit(root, ['branch', 'feature/focus-mode', initial]);
  await fixtureGit(root, ['tag', 'v0.1.0', initial]);
  await writeFile(path.join(root, 'src', 'App.tsx'), `import { Sidebar } from './components/Sidebar';\nimport { EmptyState } from './components/EmptyState';\n\nexport function App() {\n  const title = 'A little room to think.';\n  const notes = [];\n\n  return (\n    <main className="workspace">\n      <Sidebar />\n      <section className="notes-panel">\n        <h1>{title}</h1>\n        <p>Capture a thought. Make it your own.</p>\n        {notes.length === 0 && <EmptyState />}\n      </section>\n    </main>\n  );\n}\n`);
  await writeFile(path.join(root, 'src', 'styles', 'theme.css'), ':root {\n  --accent: #e77553;\n  --background: #f8f9fb;\n  --foreground: #2a3443;\n}\n');
  await writeFile(path.join(root, 'both.txt'), 'staged\n');
  await rename(path.join(root, 'docs', 'old-guide.md'), path.join(root, 'docs', 'getting started.md'));
  await fixtureGit(root, ['add', '--all', '--', 'docs', 'both.txt', 'src/styles/theme.css']);
  await writeFile(path.join(root, 'both.txt'), 'working\n');
  await unlink(path.join(root, 'legacy.config.json'));
  await writeFile(path.join(root, 'src', 'components', 'EmptyState.tsx'), `export function EmptyState() {\n  return (\n    <div className="empty-state">\n      <h2>Start with a thought.</h2>\n      <p>Your next idea belongs here.</p>\n    </div>\n  );\n}\n`);
  await writeFile(path.join(root, 'notes with spaces.txt'), 'Untracked note\nSecond line\n');
  await writeFile(path.join(root, 'literal[1].txt'), 'literal modified\n');
  await writeFile(path.join(root, 'literal1.txt'), 'other modified\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
  await writeFile(path.join(root, 'empty.txt'), '');
  return { base, root, initial, latest };
}
export async function snapshot(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(folder: string) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(folder, entry.name);
      const info = await lstat(absolute);
      hash.update(path.relative(root, absolute));
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) hash.update(await readFile(absolute));
    }
  }
  await walk(root);
  return hash.digest('hex');
}
export async function removeFixture(base: string) {
  const actual = await realpath(base);
  const relative = path.relative(await realpath(fixturesRoot), actual);
  if (path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('look-in-git-')) throw new Error('Refusing to remove a non-fixture folder.');
  await rm(actual, { recursive: true, force: true });
}
