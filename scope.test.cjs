"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { git, parseNameStatus, parseStatusZ, unionChanges, readWorktreeFile } = require('./main.js');

test('Git write operations are rejected before starting a process', async () => {
  for (const args of [['add', '-A'], ['commit', '-m', 'x'], ['push'], ['merge', 'topic'],
    ['worktree', 'remove', '/tmp/nonexistent'], ['branch', '-D', 'topic'], ['reset', '--hard']]) {
    await assert.rejects(git('/does-not-exist', args), /only runs read-only Git queries/);
  }
});

test('NUL-separated paths retain spaces, Unicode, and rename destinations', () => {
  assert.deepEqual(parseNameStatus('M\0a b.md\0R100\0old.md\0日本語.md\0'),
    [{ status: 'M', path: 'a b.md' }, { status: 'R', path: '日本語.md' }]);
  assert.deepEqual(parseStatusZ('?? a b.md\0R  new.md\0old.md\0'),
    [{ xy: '??', path: 'a b.md' }, { xy: 'R ', path: 'new.md' }]);
  assert.deepEqual(unionChanges([{ status: 'M', path: 'x.md' }],
    [{ status: '?', path: 'x.md' }, { status: '?', path: 'y.md' }]),
    [{ status: 'M', path: 'x.md' }, { status: '?', path: 'y.md' }]);
});

test('diff output ignores external diff, text conversion, and colour configuration', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-diff-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  run('init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'hello.md'), 'Hello from main.\n');
  run('add', 'hello.md');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  run('config', 'diff.external', 'false');
  run('config', 'color.ui', 'always');
  run('config', 'diff.note.textconv', 'false');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'hello.md diff=note\n');
  fs.writeFileSync(path.join(repo, 'hello.md'), 'Hello from the worktree.\n');
  const diff = await git(repo, ['diff', 'HEAD', '--', 'hello.md']);
  assert.match(diff, /\+Hello from the worktree\./);
  assert.match(diff, /-Hello from main\./);
  assert.equal(diff.includes('\x1b['), false);
});

test('previews allow worktree files and reject traversal and escaping symlinks', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-preview-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'repo');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'hello.md'), 'Hello from the worktree.');
  fs.writeFileSync(path.join(fixture, 'outside.md'), 'Outside the worktree.');
  fs.symlinkSync('hello.md', path.join(root, 'inside.md'));
  fs.symlinkSync('../outside.md', path.join(root, 'outside.md'));
  assert.equal(readWorktreeFile(root, 'hello.md'), 'Hello from the worktree.');
  assert.equal(readWorktreeFile(root, 'inside.md'), 'Hello from the worktree.');
  assert.throws(() => readWorktreeFile(root, '../outside.md'), /escapes its worktree/);
  assert.throws(() => readWorktreeFile(root, path.join(fixture, 'outside.md')), /must be relative/);
  assert.throws(() => readWorktreeFile(root, 'outside.md'), /symlink escapes its worktree/);
});
