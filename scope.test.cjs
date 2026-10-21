"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { git, parseNameStatus, parseStatusZ, unionChanges } = require('./main.js');

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

test('diff output ignores an external diff command', async (t) => {
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
  fs.writeFileSync(path.join(repo, 'hello.md'), 'Hello from the worktree.\n');
  const diff = await git(repo, ['diff', 'HEAD', '--', 'hello.md']);
  assert.match(diff, /\+Hello from the worktree\./);
  assert.match(diff, /-Hello from main\./);
  assert.equal(diff.includes('\x1b['), false);
});
