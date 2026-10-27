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
    else if (tree.has(name)) Object.assign(tree.get(name), { path: name, type: entry.type });
    else tree.set(name, { path: name, type: entry.type });
  };
  for (const [name, entry] of await scanWorktreeVault(f.sourceVault)) await adapter.reconcileFile(entry.raw, name);
  const vault = { adapter, configDir: '.obsidian', getFiles: () => [...tree.values()].filter((x) => x.type === 'file'),
    getFileByPath: name => tree.get(name)?.type === 'file' ? tree.get(name) : null };
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
  shim.addIcon = () => {};
  if (overrides.Setting) shim.Setting = overrides.Setting;
  const module = { exports: {} };
  vm.runInNewContext('(function(){' + fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') +
    '\nmodule.exports.Store = WorktreeStore; module.exports.SettingTab = WorktreeSettingTab;})()', {
      require: name => name === 'obsidian' ? shim : overrides[name] || require(name), module, console,
      document: { body: { addClass() {}, removeClass() {} } },
      window: overrides.window,
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

for (const branch of ['main', 'master', 'trunk']) {
  test(`background refresh switches from a deleted active worktree to ${branch}`, async (t) => {
    const f = await liveFixture(t);
    const run = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
    run('init', '-b', branch); run('add', 'Notes/note.md');
    run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    fs.rmSync(f.targetWorktree, { recursive: true });
    run('worktree', 'add', '-b', 'feature', f.targetWorktree);
    fs.writeFileSync(path.join(f.targetVault, 'note.md'), 'Feature content');
    const Plugin = pluginModule();
    const plugin = Object.create(Plugin.prototype);
    Object.assign(plugin, { settings: { repoPath: '', mainBranch: branch === 'trunk' ? branch : '' },
      currentWorktreePath: f.sourceWorktree, worktreeTabs: new Map(), updateWorktreeStatus() {},
      app: { vault: f.vault, metadataCache: f.cache,
        workspace: { iterateAllLeaves() {}, activeLeaf: null, getActiveFile() { return null; }, trigger() {} } } });
    plugin.store = new Plugin.Store(plugin);
    await plugin.store.refresh();
    await plugin.switchWorktree(plugin.store.state.worktrees.find(row => row.branch === 'feature'));
    assert.equal(f.adapter.getBasePath(), f.targetVault);
    const tabStates = [];
    if (branch === 'main') {
      const state = { type: 'markdown', state: { file: 'note.md' } };
      const leaf = {
        view: { file: { path: 'note.md' }, editor: { getValue: () => 'Unsaved editor text' },
          async save() { assert.fail('a deleted source must not be saved or recreated'); } },
        getViewState: () => state,
        async setViewState(next) {
          tabStates.push(next.type);
          assert.equal(f.adapter.getBasePath(), next.type === 'empty' ? f.targetVault : f.sourceVault,
            'editor clears before redirect and reopens afterward');
        },
      };
      plugin.app.workspace.iterateAllLeaves = callback => callback(leaf);
    }
    const refs = run('show-ref');
    // A real worktree removal unregisters it as well as deleting the folder.
    run('worktree', 'remove', '--force', f.targetWorktree);
    await plugin.store.refresh();
    assert.equal(plugin.currentWorktreePath, f.sourceWorktree);
    assert.equal(f.adapter.getBasePath(), f.sourceVault);
    assert.equal(fs.readFileSync(f.adapter.getFullRealPath('note.md'), 'utf8'), 'Unsaved-on-Git source note');
    assert.equal(fs.existsSync(f.targetWorktree), false);
    assert.equal(run('show-ref'), refs, 'automatic switching does not modify Git refs');
    assert.equal(plugin.autoSwitchError, null);
    if (branch === 'main') {
      assert.deepEqual(tabStates, ['empty', 'markdown'], 'the current note stays open on main');
      const folder = path.join(f.sourceConfig, 'worktree-recovery');
      const files = fs.readdirSync(folder);
      assert.equal(files.length, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, files[0]), 'utf8')), {
        sourceVault: f.targetVault, recovered: [{ file: 'note.md', content: 'Unsaved editor text' }],
      });
    }
  });
}

test('automatic switching prefers main over master and respects an explicit branch without guessing', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.targetWorktree, { recursive: true });
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  const chosen = [];
  Object.assign(plugin, { settings: { mainBranch: '' }, currentWorktreePath: f.targetWorktree,
    app: { vault: { adapter: { getBasePath: () => f.targetVault } } },
    store: { state: { worktrees: [
      { path: f.sourceWorktree, branch: 'master' },
      { path: f.sourceWorktree, branch: 'main' },
      { path: f.dir, branch: 'trunk', bare: true },
    ] } },
    async switchWorktree(row) { chosen.push(row.branch); } });
  await plugin.autoSwitchDeletedWorktree();
  assert.deepEqual(chosen, ['main']);
  plugin.settings.mainBranch = 'trunk';
  await plugin.autoSwitchDeletedWorktree();
  assert.match(plugin.autoSwitchError, /No surviving worktree for trunk/);
  assert.deepEqual(chosen, ['main'], 'an explicit branch never falls back to another branch');
  plugin.settings.mainBranch = 'master';
  await plugin.autoSwitchDeletedWorktree();
  assert.deepEqual(chosen, ['main', 'master']);
  assert.equal(plugin.autoSwitchError, null);
  plugin.switching = true;
  await plugin.autoSwitchDeletedWorktree();
  assert.deepEqual(chosen, ['main', 'master'], 'recovery does not interrupt a switch');
});

test('deleting an inactive worktree does not switch away from the active vault', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.sourceWorktree, '.git'));
  fs.rmSync(f.targetWorktree, { recursive: true });
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { currentWorktreePath: f.sourceWorktree,
    app: { vault: { adapter: { getBasePath: () => f.sourceVault } } },
    async switchWorktree() { assert.fail('must keep the active vault'); } });
  await plugin.autoSwitchDeletedWorktree();
  assert.equal(plugin.currentWorktreePath, f.sourceWorktree);
});

test('plugin keeps polling after the panel closes and stops on unload', async (t) => {
  const f = await liveFixture(t);
  const run = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { stdio: 'pipe' });
  run('init', '-b', 'main'); run('add', 'Notes/note.md');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const timers = new Map();
  const Plugin = pluginModule({ window: {
    setInterval(callback, ms) { assert.equal(ms, 4000); timers.set(1, callback); return 1; },
    clearInterval(id) { timers.delete(id); },
  } });
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { app: { vault: f.vault, metadataCache: f.cache,
    workspace: { on() {}, iterateAllLeaves() {} } },
    async loadData() { return {}; }, registerDomEvent() {}, registerView() {}, registerEvent() {},
    addSettingTab() {}, addRibbonIcon() {}, addCommand() {}, registerInterval() {},
    addStatusBarItem() { return { addClass() {}, setAttribute() {}, setText() {} }; } });
  await plugin.onload();
  await plugin.store.refresh();
  assert.equal(plugin.store.subscribers, 1, 'plugin holds a subscription without any panel');
  assert.equal(timers.size, 1);
  plugin.store.acquire();
  plugin.store.release();
  assert.equal(timers.size, 1, 'closing the last panel leaves recovery polling active');
  plugin.onunload();
  assert.equal(timers.size, 0);
});

test('failed automatic switches do not touch editors again on every poll', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.targetWorktree, { recursive: true });
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  let attempts = 0;
  Object.assign(plugin, { settings: { mainBranch: '' }, currentWorktreePath: f.targetWorktree,
    app: { vault: { adapter: { getBasePath: () => f.targetVault } } },
    store: { state: { worktrees: [{ path: f.sourceWorktree, branch: 'main', head: 'first' }] } },
    async switchWorktree() { attempts++; throw new Error('simulated adapter failure'); } });
  await plugin.autoSwitchDeletedWorktree();
  await plugin.autoSwitchDeletedWorktree();
  assert.equal(attempts, 1);
  assert.match(plugin.autoSwitchError, /simulated adapter failure/);
  plugin.store.state.worktrees[0].head = 'second';
  await plugin.autoSwitchDeletedWorktree();
  assert.equal(attempts, 2, 'a changed target allows a new attempt');
  plugin.autoSwitchAttempt = null;
  fs.rmSync(f.sourceVault, { recursive: true });
  await plugin.autoSwitchDeletedWorktree();
  assert.equal(attempts, 2, 'a missing destination vault fails before a switch starts');
  assert.match(plugin.autoSwitchError, /does not contain a vault/);
});

test('an in-flight refresh cannot start an automatic switch after unload', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.targetWorktree, { recursive: true });
  const Plugin = pluginModule();
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { settings: { mainBranch: '' }, currentWorktreePath: f.targetWorktree,
    app: { vault: { adapter: { getBasePath: () => f.targetVault } } },
    async switchWorktree() { assert.fail('unloaded plugins must not switch'); } });
  plugin.store = new Plugin.Store(plugin);
  plugin.store.state = { worktrees: [{ path: f.sourceWorktree, branch: 'main' }] };
  let finish;
  plugin.store.refreshOnce = () => new Promise(resolve => { finish = resolve; });
  const refresh = plugin.store.refresh();
  plugin.onunload();
  finish();
  await refresh;
  assert.equal(plugin.autoSwitchAttempt, undefined);
});

test('main branch edits apply on blur or Enter, never while typing', async () => {
  const fields = new Map();
  class Setting {
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    addText(callback) {
      const field = { value: '', events: {},
        setPlaceholder() { return this; }, setValue(value) { this.value = value; return this; },
        onChange(callback) { this.change = callback; return this; }, getValue() { return this.value; } };
      field.inputEl = { field, blur: () => { field.blurPromise = field.events.blur(); } };
      fields.set(this.name, field);
      callback(field);
      return this;
    }
    addToggle(callback) {
      callback({ setValue() { return this; }, onChange() { return this; } });
      return this;
    }
  }
  const Plugin = pluginModule({ Setting });
  let saves = 0;
  let refreshes = 0;
  const plugin = { settings: { repoPath: '', mainBranch: 'main', showHiddenFiles: false },
    registerDomEvent(input, name, callback) { input.field.events[name] = callback; },
    async saveData() { saves++; }, store: { async refresh() { refreshes++; } } };
  const tab = new Plugin.SettingTab({}, plugin);
  tab.containerEl = { empty() {} };
  tab.display();
  const field = fields.get('Main branch');
  field.value = 'dev';
  if (field.change) await field.change('dev');
  assert.equal(plugin.settings.mainBranch, 'main', 'a prefix cannot become the switch target');
  assert.equal(saves, 0);
  assert.equal(refreshes, 0);
  field.value = 'develop';
  await field.events.blur();
  assert.equal(plugin.settings.mainBranch, 'develop');
  assert.equal(refreshes, 1);
  field.value = 'trunk';
  field.events.keydown({ key: 'Enter' });
  await field.blurPromise;
  assert.equal(plugin.settings.mainBranch, 'trunk');
  assert.equal(refreshes, 2);
});

async function tabSwitchFixture(t, overrides = {}) {
  const f = await liveFixture(t);
  const run = (...args) => execFileSync('git', ['-C', f.sourceWorktree, ...args], { encoding: 'utf8', stdio: 'pipe' });
  run('init', '-b', 'main'); run('add', 'Notes/note.md');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  fs.rmSync(f.targetWorktree, { recursive: true });
  run('worktree', 'add', '-b', 'feature', f.targetWorktree);
  fs.writeFileSync(path.join(f.targetVault, 'note.md'), 'Feature note');
  const leaves = [];
  const listeners = new Map();
  const workspace = {
    activeLeaf: null, created: 0,
    iterateAllLeaves(callback) { [...leaves].forEach(callback); },
    on(name, callback) { listeners.set(name, callback); },
    trigger(name) { listeners.get(name)?.(); },
    getActiveFile() { return this.activeLeaf?.view.file || null; },
    setActiveLeaf(leaf) { assert.ok(leaves.includes(leaf)); this.activeLeaf = leaf; },
    getLeaf(mode) { assert.equal(mode, 'tab'); this.created++; return addLeaf(null); },
  };
  function addLeaf(file, extra = {}) {
    let state = file ? { type: 'markdown', state: { file, mode: 'source', eState: { scroll: 12 } }, ...extra } : { type: 'empty' };
    const changes = [];
    const leaf = {
      changes, detached: false,
      getViewState: () => structuredClone(state),
      async setViewState(next) {
        changes.push({ type: next.type, root: f.adapter.getBasePath() });
        state = structuredClone(next);
        if (next.type === 'markdown') {
          assert.ok(f.vault.getFileByPath(next.state.file));
          this.view = { file: { path: next.state.file }, getViewType: () => 'markdown',
            editor: { getValue: () => fs.readFileSync(f.adapter.getFullRealPath(next.state.file), 'utf8') },
            async save() {} };
        } else this.view = { getViewType: () => next.type };
      },
      detach() {
        this.detached = true;
        const index = leaves.indexOf(this);
        assert.notEqual(index, -1);
        leaves.splice(index, 1);
        if (workspace.activeLeaf === this) workspace.activeLeaf = leaves[0] || null;
      },
      view: file ? { file: { path: file }, getViewType: () => 'markdown',
        editor: { getValue: () => 'Unsaved text for ' + file }, async save() {} } : { getViewType: () => 'empty' },
    };
    leaves.push(leaf);
    return leaf;
  }
  const Plugin = pluginModule(overrides);
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { settings: { repoPath: '', mainBranch: '' }, currentWorktreePath: f.sourceWorktree,
    updateWorktreeStatus() {}, app: { vault: f.vault, metadataCache: f.cache, workspace } });
  plugin.store = new Plugin.Store(plugin);
  await plugin.store.refresh();
  for (const name of ['layout-change', 'file-open', 'active-leaf-change']) workspace.on(name, () => plugin.rememberWorktreeTabs());
  return { ...f, plugin, workspace, leaves, addLeaf, run,
    async switchTo(branch) {
      await plugin.switchWorktree(plugin.store.state.worktrees.find(row => row.branch === branch));
    } };
}

test('manual switches carry current tabs both ways, preserve focus and view state, and close only absent files', async (t) => {
  const f = await tabSwitchFixture(t);
  const first = f.addLeaf('note.md', { pinned: true });
  const duplicate = f.addLeaf('note.md');
  const initialState = first.getViewState();
  const graph = f.addLeaf(null);
  graph.view = { getViewType: () => 'graph' };
  f.workspace.activeLeaf = first;
  await f.switchTo('feature');
  assert.equal(f.workspace.activeLeaf, first);
  assert.deepEqual(first.getViewState(), initialState);
  assert.equal(f.leaves.length, 3);
  assert.equal(f.workspace.created, 0);
  assert.equal(first.view.editor.getValue(), 'Feature note');
  assert.equal(graph.changes.length, 0);
  fs.writeFileSync(path.join(f.targetVault, 'feature-only.md'), 'Feature only');
  await f.adapter.reconcileFile('feature-only.md', 'feature-only.md');
  const absent = f.addLeaf('feature-only.md');
  f.workspace.activeLeaf = absent;
  const refs = f.run('show-ref');
  await f.switchTo('main');
  assert.equal(absent.detached, true, 'absent files close their tabs instead of leaving empty placeholders');
  assert.deepEqual(f.leaves, [first, duplicate, graph]);
  assert.deepEqual(first.getViewState(), initialState);
  assert.equal(first.view.editor.getValue(), 'Unsaved-on-Git source note');
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
  assert.equal(f.run('show-ref'), refs);
  await f.switchTo('feature');
  assert.deepEqual(f.leaves, [first, duplicate, graph], 'old per-worktree layouts do not reopen a closed tab');
});

for (const detached of [false, true]) {
  test(`automatic switch restores matching tabs ${detached ? 'detached' : 'emptied'} by Obsidian before the poll`, async (t) => {
    const f = await tabSwitchFixture(t);
    await f.switchTo('feature');
    const surviving = f.addLeaf('note.md', { pinned: true });
    const state = surviving.getViewState();
    fs.writeFileSync(path.join(f.targetVault, 'feature-only.md'), 'Feature only');
    await f.adapter.reconcileFile('feature-only.md', 'feature-only.md');
    const absent = f.addLeaf('feature-only.md');
    f.workspace.activeLeaf = surviving;
    f.workspace.trigger('layout-change');
    assert.equal(f.plugin.tabSnapshot.tabs.length, 2);
    f.run('worktree', 'remove', '--force', f.targetWorktree);
    for (const leaf of [surviving, absent]) {
      if (detached) leaf.detach();
      else await leaf.setViewState({ type: 'empty' });
    }
    f.workspace.trigger('layout-change');
    assert.equal(f.plugin.tabSnapshot.tabs.length, 2, 'deletion must not overwrite the remembered tabs');
    const refs = f.run('show-ref');
    await f.plugin.store.refresh();
    assert.equal(f.adapter.getBasePath(), f.sourceVault);
    assert.equal(f.leaves.length, 1);
    assert.deepEqual(f.leaves[0].getViewState(), state);
    assert.equal(f.workspace.activeLeaf, f.leaves[0]);
    assert.equal(f.leaves[0].view.editor.getValue(), 'Unsaved-on-Git source note');
    assert.equal(f.workspace.created, detached ? 1 : 0);
    assert.equal(fs.existsSync(f.targetWorktree), false);
    assert.equal(f.run('show-ref'), refs);
    assert.equal(f.plugin.autoSwitchError, null);
  });
}

test('tabs closed by the user in a healthy worktree are not reopened on deletion', async (t) => {
  const f = await tabSwitchFixture(t);
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  f.workspace.trigger('file-open');
  leaf.detach();
  f.workspace.trigger('layout-change');
  assert.equal(f.plugin.tabSnapshot.tabs.length, 0);
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await f.plugin.store.refresh();
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.equal(f.leaves.length, 0);
  assert.equal(f.workspace.created, 0);
});

test('note-first cleanup retains matching tabs until the worktree deletion switch', async (t) => {
  const f = await tabSwitchFixture(t);
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  f.workspace.activeLeaf = leaf;
  f.workspace.trigger('file-open');
  fs.unlinkSync(path.join(f.targetVault, 'note.md'));
  leaf.detach();
  assert.equal(fs.existsSync(path.join(f.targetWorktree, '.git')), true);
  f.workspace.trigger('layout-change');
  assert.equal(f.plugin.tabSnapshot.tabs.length, 1, 'missing notes must survive in the snapshot even before .git is removed');
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await f.plugin.store.refresh();
  assert.equal(f.leaves.length, 1);
  assert.equal(f.leaves[0].view.file.path, 'note.md');
  assert.equal(f.workspace.activeLeaf, f.leaves[0]);
  assert.equal(f.plugin.autoSwitchError, null);
});

test('tabs closed after a failed automatic switch stay closed on a later manual switch', async (t) => {
  const f = await tabSwitchFixture(t);
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  f.workspace.trigger('file-open');
  f.plugin.settings.mainBranch = 'missing-branch';
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await f.plugin.store.refresh();
  assert.match(f.plugin.autoSwitchError, /No surviving worktree/);
  leaf.detach();
  f.workspace.trigger('layout-change');
  assert.equal(f.plugin.tabSnapshot.tabs.length, 0);
  await f.switchTo('main');
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.equal(f.leaves.length, 0);
  assert.equal(f.workspace.created, 0);
});

test('a deleted file tab reused for a graph stays intact while its note reopens separately', async (t) => {
  const f = await tabSwitchFixture(t);
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  f.workspace.activeLeaf = leaf;
  f.workspace.trigger('file-open');
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await leaf.setViewState({ type: 'graph' });
  f.workspace.trigger('layout-change');
  await f.plugin.store.refresh();
  assert.equal(f.leaves.length, 2);
  assert.equal(leaf.view.getViewType(), 'graph');
  assert.equal(f.leaves[1].view.file.path, 'note.md');
  assert.equal(f.workspace.activeLeaf, leaf);
});

for (const event of ['layout-change', 'file-open', 'active-leaf-change']) {
  test(`tabs already closed by deletion survive ${event} after an automatic switch fails`, async (t) => {
    const f = await tabSwitchFixture(t);
    await f.switchTo('feature');
    const leaf = f.addLeaf('note.md');
    const state = leaf.getViewState();
    f.workspace.activeLeaf = leaf;
    f.workspace.trigger('file-open');
    f.plugin.settings.mainBranch = 'missing-branch';
    f.run('worktree', 'remove', '--force', f.targetWorktree);
    leaf.detach();
    await f.plugin.store.refresh();
    assert.match(f.plugin.autoSwitchError, /No surviving worktree/);
    assert.equal(f.plugin.tabsClosedBeforeFailure.length, 1);
    f.workspace.trigger(event);
    assert.equal(f.plugin.tabSnapshot.tabs.length, 1, 'choosing another pane must not erase deletion-closed tabs');
    await f.switchTo('main');
    assert.equal(f.leaves.length, 1);
    assert.deepEqual(f.leaves[0].getViewState(), state);
    assert.equal(f.workspace.activeLeaf, f.leaves[0]);
    assert.equal(f.leaves[0].view.editor.getValue(), 'Unsaved-on-Git source note');
    assert.equal(f.plugin.autoSwitchError, null);
    assert.equal(f.plugin.tabsClosedBeforeFailure, null);
  });
}

// Model Obsidian TextFileView's bound autosave, saving gate and saved baseline.
// The queued callback calls the original save function, not a replaced method.
function liveMarkdownEditor(f, leaf) {
  const view = leaf.view;
  let content = fs.readFileSync(f.adapter.getFullRealPath(view.file.path), 'utf8');
  Object.assign(view, { file: f.vault.getFileByPath(view.file.path), saving: false, saveAgain: false,
    dirty: false, lastSavedData: content, data: content,
    getViewData: () => content,
    setData(next, clear) { content = next; this.data = next; this.resetHistory = clear; },
    getEphemeralState: () => ({ cursor: { line: 0, ch: 2 }, scroll: 13 }),
    setEphemeralState(state) { this.restoredEphemeral = state; },
    editor: { getValue: () => content },
    async save() {
      this.dirty = false;
      if (this.saving) { this.saveAgain = true; return; }
      if (this.lastSavedData === null || content === this.lastSavedData) return;
      const data = content;
      this.lastSavedData = data;
      this.saving = true;
      try { await f.adapter.queue(() => fs.writeFileSync(f.adapter.getFullRealPath(this.file.path), data)); }
      finally { this.saving = false; }
    },
  });
  const queuedSave = view.save.bind(view);
  return { view, queuedSave, edit(value) { content = value; view.dirty = true; } };
}

test('matching Markdown editors stay mounted while queued saves cannot copy source text into the destination', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md', { pinned: true });
  const { view, queuedSave, edit } = liveMarkdownEditor(f, leaf);
  f.workspace.activeLeaf = leaf;
  const state = leaf.getViewState();
  edit('Unsaved source edit');
  let savesDuringSwitch = 0;
  const reconcile = f.adapter.reconcileFile;
  f.adapter.reconcileFile = async function (...args) {
    if (this.getBasePath() === f.targetVault) {
      assert.equal(view.saving, true, 'autosaves are paused while paths point to the destination');
      await queuedSave();
      savesDuringSwitch++;
    }
    return reconcile.apply(this, args);
  };
  await f.switchTo('feature');
  assert.ok(savesDuringSwitch > 0);
  assert.equal(leaf.view, view, 'the exact editor instance survives');
  assert.deepEqual(leaf.changes, [], 'the leaf never closes or switches to an empty view');
  assert.deepEqual(leaf.getViewState(), state);
  assert.deepEqual(view.restoredEphemeral, { cursor: { line: 0, ch: 2 }, scroll: 13 });
  assert.equal(view.getViewData(), 'Feature note');
  assert.equal(view.resetHistory, true, 'a branch switch must clear undo history');
  assert.equal(f.workspace.activeLeaf, leaf);
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Unsaved source edit');
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
  assert.equal(view.saving, false);
  assert.equal(view.saveAgain, false);
  edit('New destination edit');
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'New destination edit');
});

test('an open Markdown editor remains mounted after deletion while unsaved text is backed up', async (t) => {
  const f = await tabSwitchFixture(t);
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  const { view, queuedSave, edit } = liveMarkdownEditor(f, leaf);
  edit('Unsaved deleted-worktree buffer');
  f.workspace.trigger('file-open');
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await f.plugin.store.refresh();
  assert.equal(leaf.view, view);
  assert.deepEqual(leaf.changes, []);
  assert.equal(view.getViewData(), 'Unsaved-on-Git source note');
  const folder = path.join(f.sourceConfig, 'worktree-recovery');
  const backup = JSON.parse(fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'utf8'));
  assert.equal(backup.recovered[0].content, 'Unsaved deleted-worktree buffer');
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Unsaved-on-Git source note');
  assert.equal(fs.existsSync(f.targetWorktree), false);
});

test('a failed root switch restores the editor save baseline without unloading it', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { view, queuedSave, edit } = liveMarkdownEditor(f, leaf);
  f.adapter.failOnce = true;
  await assert.rejects(f.switchTo('feature'), /restored the previous vault/);
  assert.equal(leaf.view, view);
  assert.deepEqual(leaf.changes, []);
  assert.equal(view.getViewData(), 'Unsaved-on-Git source note');
  assert.equal(view.lastSavedData, 'Unsaved-on-Git source note');
  assert.equal(view.saving, false);
  edit('Edit after rollback');
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Edit after rollback');
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('an incompatible Markdown refresh falls back to reopening without copying source text', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { view, queuedSave } = liveMarkdownEditor(f, leaf);
  view.setData = () => { throw new Error('unsupported editor'); };
  await f.switchTo('feature');
  assert.deepEqual(leaf.changes.map(change => change.type), ['empty', 'markdown']);
  assert.equal(leaf.view.editor.getValue(), 'Feature note');
  assert.equal(view.lastSavedData, null);
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('an in-flight editor save prevents root changes without cancelling that save', async (t) => {
  const f = await tabSwitchFixture(t);
  const first = f.addLeaf('note.md');
  const second = f.addLeaf('note.md');
  const one = liveMarkdownEditor(f, first);
  const two = liveMarkdownEditor(f, second);
  two.view.save = async () => { two.view.saving = true; };
  await assert.rejects(f.switchTo('feature'), /still being saved/);
  assert.equal(f.adapter.getBasePath(), f.sourceVault);
  assert.equal(two.view.saving, true, 'the existing save remains in control of its own flag');
  assert.equal(one.view.saving, false);
  assert.equal(one.view.lastSavedData, 'Unsaved-on-Git source note');
  assert.deepEqual(first.changes, []);
  assert.deepEqual(second.changes, []);
});

test('edits received during the rebase are backed up before the editor is replaced', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { queuedSave, edit } = liveMarkdownEditor(f, leaf);
  const reconcile = f.adapter.reconcileFile;
  let edited = false;
  f.adapter.reconcileFile = async function (...args) {
    if (!edited && this.getBasePath() === f.targetVault) {
      edit('Text received during the switch');
      edited = true;
    }
    return reconcile.apply(this, args);
  };
  await f.switchTo('feature');
  const folder = path.join(f.sourceConfig, 'worktree-recovery');
  const backups = fs.readdirSync(folder);
  assert.equal(backups.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(folder, backups[0]), 'utf8'));
  assert.equal(backup.sourceVault, f.sourceVault);
  assert.equal(backup.recovered[0].content, 'Text received during the switch');
  assert.deepEqual(leaf.changes.map(change => change.type), ['empty', 'markdown']);
  assert.equal(leaf.view.editor.getValue(), 'Feature note');
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('edits arriving after the source save use the unload path and are saved to the source', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { view, edit } = liveMarkdownEditor(f, leaf);
  const queue = f.adapter.queue;
  let edited = false;
  f.adapter.queue = function (callback) {
    if (!edited && f.plugin.switching && !view.saving && this.getBasePath() === f.sourceVault) {
      edit('Late source edit');
      edited = true;
    }
    return queue.call(this, callback);
  };
  const setViewState = leaf.setViewState;
  leaf.setViewState = async function (state) {
    if (state.type === 'empty' && this.view === view) await view.save();
    return setViewState.call(this, state);
  };
  await f.switchTo('feature');
  assert.equal(edited, true);
  assert.deepEqual(leaf.changes.map(change => change.type), ['empty', 'markdown']);
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Late source edit');
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('a fallback-close failure cannot leave an editor mounted with disabled autosaves', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { view } = liveMarkdownEditor(f, leaf);
  view.setData = () => { throw new Error('unsupported refresh'); };
  const setViewState = leaf.setViewState;
  let failures = 0;
  leaf.setViewState = async function (state) {
    if (state.type === 'empty' && failures++ === 0) throw new Error('first close failed');
    return setViewState.call(this, state);
  };
  await assert.rejects(f.switchTo('feature'), /first close failed/);
  assert.equal(f.adapter.getBasePath(), f.targetVault);
  assert.equal(leaf.view.getViewType(), 'empty');
  assert.equal(view.saving, false);
  assert.equal(view.lastSavedData, null);
  assert.equal(f.plugin.switching, false);
});

test('a failed late-edit backup keeps the buffer visible and surfaces paused autosaves', async (t) => {
  const f = await tabSwitchFixture(t, { fs: { ...fs, promises: { ...fs.promises,
    async writeFile() { throw new Error('backup disk full'); } } } });
  const leaf = f.addLeaf('note.md');
  const { view, edit } = liveMarkdownEditor(f, leaf);
  const reconcile = f.adapter.reconcileFile;
  f.adapter.reconcileFile = async function (...args) {
    if (this.getBasePath() === f.targetVault) edit('Keep this unsaved buffer');
    return reconcile.apply(this, args);
  };
  await assert.rejects(f.switchTo('feature'), /could not be backed up or closed safely/);
  assert.equal(leaf.view, view);
  assert.equal(view.getViewData(), 'Keep this unsaved buffer');
  assert.equal(view.saving, true);
  assert.equal(view.lastSavedData, null);
  assert.equal(f.plugin.switching, false);
  assert.deepEqual(leaf.changes, []);
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('edits received while the deleted-source backup is written are preserved separately', async (t) => {
  let editBuffer;
  let writes = 0;
  const f = await tabSwitchFixture(t, { fs: { ...fs, promises: { ...fs.promises,
    async writeFile(...args) {
      if (++writes === 1) editBuffer('Late deleted-source text');
      return fs.promises.writeFile(...args);
    } } } });
  await f.switchTo('feature');
  const leaf = f.addLeaf('note.md');
  const { edit } = liveMarkdownEditor(f, leaf);
  editBuffer = edit;
  edit('Initial deleted-source text');
  f.run('worktree', 'remove', '--force', f.targetWorktree);
  await f.plugin.store.refresh();
  const folder = path.join(f.sourceConfig, 'worktree-recovery');
  const backups = fs.readdirSync(folder).map(file => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')));
  assert.equal(backups.length, 2);
  assert.deepEqual(backups.map(backup => backup.recovered[0].content).sort(),
    ['Initial deleted-source text', 'Late deleted-source text']);
  assert.equal(leaf.view.editor.getValue(), 'Unsaved-on-Git source note');
  assert.equal(fs.existsSync(f.targetWorktree), false);
});

test('cleanup backs up late edits in an editor not reached after an earlier refresh fails', async (t) => {
  const f = await tabSwitchFixture(t);
  const first = f.addLeaf('note.md');
  const second = f.addLeaf('note.md');
  const one = liveMarkdownEditor(f, first);
  const two = liveMarkdownEditor(f, second);
  one.view.setData = () => { throw new Error('unsupported first editor'); };
  const firstSetState = first.setViewState;
  let closeAttempts = 0;
  first.setViewState = async function (state) {
    if (state.type === 'empty' && closeAttempts++ === 0) throw new Error('first close failed');
    return firstSetState.call(this, state);
  };
  const reconcile = f.adapter.reconcileFile;
  f.adapter.reconcileFile = async function (...args) {
    if (this.getBasePath() === f.targetVault) two.edit('Late edit in the unreached editor');
    return reconcile.apply(this, args);
  };
  await assert.rejects(f.switchTo('feature'), /first close failed/);
  const folder = path.join(f.sourceConfig, 'worktree-recovery');
  const backups = fs.readdirSync(folder).map(file => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')));
  assert.ok(backups.some(backup => backup.recovered[0].content === 'Late edit in the unreached editor'));
  assert.equal(second.view.getViewType(), 'empty');
  assert.equal(two.view.saving, false);
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});

test('rollback reschedules autosave when an edit arrived while saving was paused', async (t) => {
  const f = await tabSwitchFixture(t);
  const leaf = f.addLeaf('note.md');
  const { view, queuedSave, edit } = liveMarkdownEditor(f, leaf);
  let requestedSaves = 0;
  view.requestSave = () => { requestedSaves++; view.dirty = true; };
  const reconcile = f.adapter.reconcileFile;
  f.adapter.reconcileFile = async function (...args) {
    if (this.getBasePath() === f.targetVault) {
      edit('Edit during a failed switch');
      await queuedSave();
    }
    return reconcile.apply(this, args);
  };
  f.adapter.failOnce = true;
  await assert.rejects(f.switchTo('feature'), /restored the previous vault/);
  assert.equal(leaf.view, view);
  assert.equal(view.getViewData(), 'Edit during a failed switch');
  assert.equal(view.saving, false);
  assert.equal(requestedSaves, 1);
  await queuedSave();
  assert.equal(fs.readFileSync(path.join(f.sourceVault, 'note.md'), 'utf8'), 'Edit during a failed switch');
  assert.equal(fs.readFileSync(path.join(f.targetVault, 'note.md'), 'utf8'), 'Feature note');
});
