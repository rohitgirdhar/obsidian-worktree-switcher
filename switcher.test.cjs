'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveWorktreeVault, isHiddenPath, scanWorktreeVault, rebaseWorktreeVault, preserveDeletedWorktreeBuffers } = require('./main.js');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-worktree-switch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceWorktree = path.join(dir, 'main');
  const targetWorktree = path.join(dir, 'feature');
  const sourceVault = path.join(sourceWorktree, 'Notes');
  const targetVault = path.join(targetWorktree, 'Notes');
  const sourceConfig = path.join(sourceVault, '.obsidian');
  const targetConfig = path.join(targetVault, '.obsidian');
  fs.mkdirSync(sourceConfig, { recursive: true });
  fs.mkdirSync(targetVault, { recursive: true });
  fs.writeFileSync(path.join(sourceVault, 'note.md'), 'Unsaved-on-Git source note');
  fs.writeFileSync(path.join(targetVault, 'note.md'), 'Different target branch note');
  return { dir, sourceWorktree, targetWorktree, sourceVault, targetVault, sourceConfig, targetConfig };
}

test('maps a subfolder vault into the selected worktree, including spaces', (t) => {
  const f = fixture(t);
  assert.equal(resolveWorktreeVault(f.sourceVault, f.sourceWorktree, f.targetWorktree), f.targetVault);
  const renamed = path.join(f.dir, 'feature with spaces');
  fs.renameSync(f.targetWorktree, renamed);
  assert.equal(resolveWorktreeVault(f.sourceVault, f.sourceWorktree, renamed), path.join(renamed, 'Notes'));
  assert.equal(resolveWorktreeVault(f.sourceWorktree, f.sourceWorktree, renamed), renamed);
});

test('rejects missing vaults, unrelated source folders, and escaped target symlinks', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveWorktreeVault(f.sourceVault, f.targetWorktree, f.sourceWorktree), /outside/);
  fs.rmSync(f.targetVault, { recursive: true });
  assert.throws(() => resolveWorktreeVault(f.sourceVault, f.sourceWorktree, f.targetWorktree), /does not contain a vault/);
  fs.symlinkSync(f.sourceVault, f.targetVault, 'dir');
  assert.throws(() => resolveWorktreeVault(f.sourceVault, f.sourceWorktree, f.targetWorktree), /outside its worktree/);
});

test('in-place switching preserves branch refs and dirty notes in real Git worktrees', async (t) => {
  const f = await liveFixture(t);
  fs.rmSync(f.targetWorktree, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-b', 'master');
  git('add', 'Notes/note.md');
  git('-c', 'user.name=Switcher Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'notes/test', f.targetWorktree);
  fs.writeFileSync(path.join(f.sourceVault, 'note.md'), 'Dirty main note');
  fs.writeFileSync(path.join(f.targetVault, 'note.md'), 'Dirty feature note');
  const refs = git('show-ref');
  await rebaseWorktreeVault(f.vault, f.cache, f.targetVault);
  assert.equal(git('show-ref'), refs);
  assert.equal(git('branch', '--show-current').trim(), 'master');
  assert.equal(execFileSync('git', ['-C', f.targetWorktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'notes/test');
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Dirty main note');
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Dirty feature note');
});

test('hidden-file filtering supports custom settings and leaves notes visible', () => {
  assert.equal(isHiddenPath('Notes/.obsidian/plugins/example/main.js'), true);
  assert.equal(isHiddenPath('Notes/.custom-config/workspace.json'), true);
  assert.equal(isHiddenPath('.gitignore'), true);
  assert.equal(isHiddenPath('Notes/hello.md'), false);
  assert.equal(isHiddenPath('Notes/attachments/hello.png'), false);
  assert.equal(isHiddenPath('Notes/obsidian-guide.md'), false);
});

// Use real directories and real reads/writes. The small adapter below implements
// the desktop adapter's event/queue contract; native UI verification covers the
// actual installed Obsidian implementation as well.
async function liveFixture(t) {
  const f = fixture(t);
  const events = [];
  const tree = new Map();
  const metadata = new Map();
  const cache = { workQueue: { queue: (fn) => Promise.resolve().then(fn) },
    saveFileCache: (name, value) => metadata.set(name, value) };
  const adapter = {
    basePath: f.sourceVault, files: { '/': { type: 'folder', realpath: '/' } }, promise: Promise.resolve(),
    getBasePath() { return this.basePath; },
    getFullRealPath(name) { return path.join(this.basePath, name); },
    queue(fn) { const next = this.promise.then(fn, fn); this.promise = next; return next; },
    stopWatch() { this.handler = null; this.watching = false; },
    async startWatchPath() { this.watching = true; },
    async watchHiddenRecursive() {},
    async reconcileDeletion(raw, name) {
      for (const key of Object.keys(this.files)) {
        if (key === name || key.startsWith(name + '/')) {
          delete this.files[key]; this.handler?.('delete', key);
        }
      }
    },
    async reconcileFile(raw, name) {
      if (this.failOnce) { this.failOnce = false; throw new Error('simulated scan failure'); }
      const stat = fs.statSync(this.getFullRealPath(raw));
      const old = this.files[name];
      const entry = { realpath: raw, type: stat.isDirectory() ? 'folder' : 'file', mtime: Math.round(stat.mtimeMs), size: stat.size };
      this.files[name] = entry;
      if (!old) this.handler?.('create', name, entry);
      else if (entry.type === 'file' && old.mtime !== entry.mtime) this.handler?.('modify', name, entry);
    },
  };
  adapter.handler = (event, name, entry) => {
    events.push([event, name]);
    if (event === 'delete') tree.delete(name);
    else tree.set(name, { path: name, type: entry.type });
  };
  for (const [name, entry] of await scanWorktreeVault(f.sourceVault)) await adapter.reconcileFile(entry.raw, name);
  const vault = { adapter, configDir: '.obsidian', getFiles: () => [...tree.values()].filter((x) => x.type === 'file') };
  return { ...f, adapter, vault, cache, metadata, events, tree };
}

test('in-place switch redirects reads and edits, reconciles file trees, and keeps settings at home', async (t) => {
  const f = await liveFixture(t);
  fs.writeFileSync(path.join(f.sourceVault, 'source-only.md'), 'main only');
  fs.writeFileSync(path.join(f.targetVault, 'target-only.md'), 'feature only');
  fs.mkdirSync(path.join(f.targetVault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(f.targetConfig, 'app.json'), '{"target":"untouched"}');
  await f.adapter.reconcileFile('source-only.md', 'source-only.md');
  await rebaseWorktreeVault(f.vault, f.cache, f.targetVault);
  assert.equal(f.vault.adapter, f.adapter, 'native vault/adapter identity stays the same');
  assert.deepEqual(f.vault.getFiles().map((x) => x.path).sort(), ['note.md', 'target-only.md']);
  assert.equal(fs.readFileSync(f.adapter.getFullRealPath('note.md'), 'utf8'), 'Different target branch note');
  fs.writeFileSync(f.adapter.getFullRealPath('note.md'), 'edited feature');
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Unsaved-on-Git source note');
  fs.writeFileSync(f.adapter.getFullRealPath('.obsidian/app.json'), '{"home":true}');
  assert.equal(fs.readFileSync(path.join(f.targetConfig, 'app.json'), 'utf8'), '{"target":"untouched"}');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.sourceConfig, 'app.json'))), { home: true });
  await rebaseWorktreeVault(f.vault, f.cache, f.sourceVault);
  assert.deepEqual(f.vault.getFiles().map((x) => x.path).sort(), ['note.md', 'source-only.md']);
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'edited feature');
  assert.equal(f.adapter.watching, true);
});

test('same-mtime same-size branch notes invalidate metadata and emit modify', async (t) => {
  const f = await liveFixture(t);
  fs.writeFileSync(path.join(f.sourceVault, 'note.md'), 'main');
  fs.writeFileSync(path.join(f.targetVault, 'note.md'), 'feature');
  for (const root of [f.sourceVault, f.targetVault]) fs.utimesSync(path.join(root, 'note.md'), 100, 100);
  await f.adapter.reconcileFile('note.md', 'note.md');
  f.metadata.set('note.md', { hash: 'old-main-content' });
  f.events.length = 0;
  await rebaseWorktreeVault(f.vault, f.cache, f.targetVault);
  assert.equal(f.metadata.get('note.md'), null);
  assert.ok(f.events.some(([event, name]) => event === 'modify' && name === 'note.md'));
});

test('failed in-place switch rolls back its root, tree, and watchers without touching note contents', async (t) => {
  const f = await liveFixture(t);
  f.adapter.failOnce = true;
  await assert.rejects(rebaseWorktreeVault(f.vault, f.cache, f.targetVault), /restored the previous vault/);
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.deepEqual(f.vault.getFiles().map((x) => x.path), ['note.md']);
  assert.equal(f.adapter.watching, true);
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Different target branch note');
});

test('unsupported adapters and escaped symlinks fail before changing the active root', async (t) => {
  const f = await liveFixture(t);
  const reconcile = f.adapter.reconcileFile;
  f.adapter.reconcileFile = undefined;
  await assert.rejects(rebaseWorktreeVault(f.vault, f.cache, f.targetVault), /missing adapter.reconcileFile/);
  f.adapter.reconcileFile = reconcile;
  fs.symlinkSync(path.join(f.sourceVault, 'note.md'), path.join(f.targetVault, 'outside.md'));
  await assert.rejects(rebaseWorktreeVault(f.vault, f.cache, f.targetVault), /escapes its worktree/);
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.equal(typeof f.adapter.handler, 'function');
});

test('scanner rejects filename collisions and recursive symlinks without reading hidden configuration', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.targetVault, 'a b.md'), 'a');
  fs.writeFileSync(path.join(f.targetVault, 'a\u00a0b.md'), 'b');
  await assert.rejects(scanWorktreeVault(f.targetVault), /normalize to the same name/);
  fs.unlinkSync(path.join(f.targetVault, 'a\u00a0b.md'));
  fs.symlinkSync(f.targetVault, path.join(f.targetVault, 'loop'));
  await assert.rejects(scanWorktreeVault(f.targetVault), /forms a loop/);
});

test('a deleted source worktree still maps to an existing target vault', (t) => {
  const f = fixture(t);
  fs.rmSync(f.sourceWorktree, { recursive: true });
  assert.throws(() => resolveWorktreeVault(f.sourceVault, f.sourceWorktree, f.targetWorktree), /ENOENT/);
  assert.equal(resolveWorktreeVault(f.sourceVault, f.sourceWorktree, f.targetWorktree,
    { allowMissingSource: true }), f.targetVault);
  assert.throws(() => resolveWorktreeVault(path.join(f.dir, 'outside'), f.sourceWorktree,
    f.targetWorktree, { allowMissingSource: true }), /outside/);
  assert.equal(fs.existsSync(f.sourceWorktree), false);
});

test('recovering from a deleted current vault reconciles the tree without recreating it', async (t) => {
  const f = await liveFixture(t);
  // The settings root was pinned on the first switch, before the worktree disappeared.
  f.adapter[Symbol.for('worktree-switcher.root-routing')] = { home: f.targetVault, configDir: '.obsidian' };
  fs.rmSync(f.sourceWorktree, { recursive: true });
  await rebaseWorktreeVault(f.vault, f.cache, f.targetVault);
  assert.equal(f.adapter.getBasePath(), f.targetVault);
  assert.deepEqual(f.vault.getFiles().map(x => x.path), ['note.md']);
  assert.equal(fs.readFileSync(f.adapter.getFullRealPath('note.md'), 'utf8'), 'Different target branch note');
  assert.equal(fs.existsSync(f.sourceWorktree), false);
  assert.equal(f.adapter.watching, true);
});

test('a deleted destination fails before redirecting reads or changing the source tree', async (t) => {
  const f = await liveFixture(t);
  fs.rmSync(f.targetWorktree, { recursive: true });
  await assert.rejects(rebaseWorktreeVault(f.vault, f.cache, f.targetVault), /ENOENT/);
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.deepEqual(f.vault.getFiles().map(x => x.path), ['note.md']);
  assert.equal(fs.readFileSync(f.adapter.getFullRealPath('note.md'), 'utf8'), 'Unsaved-on-Git source note');
});

test('deleted source editor buffers are preserved at the surviving settings root', async (t) => {
  const f = await liveFixture(t);
  f.adapter[Symbol.for('worktree-switcher.root-routing')] = { home: f.targetVault, configDir: '.obsidian' };
  fs.rmSync(f.sourceWorktree, { recursive: true });
  const file = await preserveDeletedWorktreeBuffers(f.vault, [
    { file: 'note.md', leaf: { view: { editor: { getValue: () => 'Unsaved recovered text' } } } },
  ], f.sourceVault);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    sourceVault: f.sourceVault, recovered: [{ file: 'note.md', content: 'Unsaved recovered text' }],
  });
  assert.equal(fs.existsSync(f.sourceWorktree), false);
  await assert.rejects(preserveDeletedWorktreeBuffers(f.vault,
    [{ file: 'drawing.canvas', leaf: { view: {} } }], f.sourceVault), /Save open non-text files/);
});

function pluginModule(overrides = {}) {
  const vm = require('node:vm');
  const shim = Object.fromEntries(['Plugin', 'ItemView', 'PluginSettingTab', 'Setting',
    'SuggestModal', 'MarkdownRenderer'].map(name => [name, class {}]));
  shim.Events = class { trigger() {} };
  shim.Notice = class { hide() {} };
  const module = { exports: {} };
  vm.runInNewContext('(function(){' + fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') +
    '\nmodule.exports.Store = WorktreeStore;})()', {
      require: name => name === 'obsidian' ? shim : overrides[name] || require(name), module, console,
      document: { body: { addClass() {}, removeClass() {} } },
    });
  return module.exports;
}

test('list refresh ignores deleted Git registrations and awaits concurrent refreshes', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'master'); git('add', 'Notes/note.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  fs.rmSync(f.targetWorktree, { recursive: true });
  git('worktree', 'add', '-b', 'feature', f.targetWorktree);
  fs.rmSync(f.targetWorktree, { recursive: true });
  const { Store } = pluginModule();
  const store = new Store({ settings: { repoPath: f.sourceWorktree }, updateWorktreeStatus() {} });
  const one = store.refresh(); const two = store.refresh();
  await two;
  assert.equal(store.refreshPromise, null, 'second caller waits for the real refresh');
  assert.equal(store.staleSince, null);
  assert.equal(store.state.worktrees.length, 1);
  assert.equal(store.state.worktrees[0].path, f.sourceWorktree);
  await one;
  store.plugin.settings.repoPath = '';
  store.plugin.app = { vault: { adapter: { getBasePath: () => f.targetVault } } };
  assert.equal(store.repoPath(), f.sourceWorktree, 'Git remains anchored to the main checkout after deletion');
});

test('the full switch command leaves a deleted current worktree without spawning Git in it', async (t) => {
  const f = await liveFixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.targetWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'master'); git('add', 'Notes/note.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  plugin.currentWorktreePath = f.sourceWorktree;
  plugin.worktreeTabs = new Map();
  plugin.updateWorktreeStatus = () => {};
  plugin.app = { vault: f.vault, metadataCache: f.cache,
    workspace: { iterateAllLeaves() {}, activeLeaf: null, getActiveFile() { return null; }, trigger() {} } };
  plugin.store = { repoPath: () => f.targetWorktree, refresh: async () => {}, staleSince: null,
    state: { worktrees: [{ path: f.targetWorktree, branch: 'master' }] }, trigger() {} };
  f.adapter[Symbol.for('worktree-switcher.root-routing')] = { home: f.targetVault, configDir: '.obsidian' };
  fs.rmSync(f.sourceWorktree, { recursive: true });
  await plugin.switchWorktree({ path: f.targetWorktree });
  assert.equal(f.adapter.getBasePath(), f.targetVault);
  assert.equal(plugin.currentWorktreePath, f.targetWorktree);
  assert.equal(plugin.switching, false);
  assert.equal(fs.existsSync(f.sourceWorktree), false);
});

test('a worktree deleted during a later Git query does not break other rows', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'master'); git('add', 'Notes/note.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  fs.rmSync(f.targetWorktree, { recursive: true });
  git('worktree', 'add', '-b', 'feature', f.targetWorktree);
  const childProcess = require('node:child_process');
  let deleted = false;
  const execFile = (...args) => childProcess.execFile(...args);
  const { promisify } = require('node:util');
  execFile[promisify.custom] = async (command, args, options) => {
    if (options.cwd === f.targetWorktree && args.includes('diff')) {
      fs.rmSync(f.targetWorktree, { recursive: true }); deleted = true;
    }
    return promisify(childProcess.execFile)(command, args, options);
  };
  const Plugin = pluginModule({ child_process: { execFile } });
  const store = new Plugin.Store({ settings: { repoPath: f.sourceWorktree }, updateWorktreeStatus() {} });
  await store.refresh();
  assert.equal(deleted, true);
  assert.equal(store.staleSince, null);
  assert.equal(store.state.worktrees.length, 1);
  assert.equal(store.state.worktrees[0].path, f.sourceWorktree);
});

test('unrelated worktree history does not block switching', async (t) => {
  const f = await liveFixture(t);
  const run = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  run('init', '-b', 'main');
  run('add', 'Notes/note.md');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const independent = run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit-tree', run('rev-parse', 'HEAD^{tree}'), '-m', 'Independent hello');
  run('update-ref', 'refs/heads/pages', independent);
  fs.rmSync(f.targetWorktree, { recursive: true });
  run('worktree', 'add', f.targetWorktree, 'pages');
  fs.writeFileSync(path.join(f.targetVault, 'note.md'), 'Hello from the independent worktree');
  const refs = run('show-ref');
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { settings: { repoPath: f.sourceWorktree }, currentWorktreePath: f.sourceWorktree,
    worktreeTabs: new Map(), updateWorktreeStatus() {},
    app: { vault: f.vault, metadataCache: f.cache, workspace: { iterateAllLeaves() {}, activeLeaf: null, getActiveFile() { return null; }, trigger() {} } } });
  plugin.store = new Plugin.Store(plugin);
  await plugin.store.refresh();
  assert.equal(plugin.store.staleSince, null);
  assert.equal(plugin.store.state.worktrees.length, 2);
  const target = plugin.store.state.worktrees.find(row => row.branch === 'pages');
  assert.equal(target.diffTarget, 'HEAD');
  assert.equal(target.changes[0].path, 'Notes/note.md');
  await plugin.switchWorktree(target);
  assert.equal(f.adapter.getBasePath(), f.targetVault);
  assert.equal(fs.readFileSync(f.adapter.getFullRealPath('note.md'), 'utf8'), 'Hello from the independent worktree');
  await plugin.switchWorktree(plugin.store.state.worktrees.find(row => row.branch === 'main'));
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.equal(run('show-ref'), refs);
});

test('hidden-file settings control main-worktree change events', async (t) => {
  const f = fixture(t);
  const run = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
  run('init', '-b', 'main'); run('add', 'Notes/note.md');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const { Store } = pluginModule();
  const store = new Store({ settings: { repoPath: f.sourceWorktree, showHiddenFiles: true }, updateWorktreeStatus() {} });
  const events = [];
  store.trigger = name => events.push(name);
  await store.refresh();
  assert.equal(store.state.worktrees[0].changes.length, 0);
  events.length = 0;
  fs.writeFileSync(path.join(f.sourceWorktree, '.hidden-note'), 'Hello from a hidden note');
  await store.refresh();
  assert.equal(events.filter(name => name === 'change').length, 1);
  assert.equal(store.state.worktrees[0].changes[0].path, '.hidden-note');
  events.length = 0;
  store.plugin.settings.showHiddenFiles = false;
  await store.refresh();
  assert.equal(events.filter(name => name === 'change').length, 1);
  assert.equal(store.state.worktrees[0].changes.length, 0);
  events.length = 0;
  fs.writeFileSync(path.join(f.sourceWorktree, '.another-hidden-note'), 'Hidden by the setting');
  await store.refresh();
  assert.equal(events.filter(name => name === 'change').length, 0);
});
