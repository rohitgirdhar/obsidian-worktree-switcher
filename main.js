'use strict';

/*
 * Worktree Switcher
 * Derived from Worktree Viewer by Sebastian Winkler, MIT licensed.
 * Same-window switching and deletion recovery by Rohit Girdhar.
 * See LICENSE and NOTICE for attribution.
 */

/*
MIT License

Copyright (c) 2026 Sebastian Winkler
Copyright (c) 2026 Rohit Girdhar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
let obsidian = null;
try { obsidian = require('obsidian'); } catch (_) { /* running under node, not Obsidian */ }

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileP = promisify(execFile);

// ---------------- pure core (tested via `node --test`) ----------------

async function git(cwd, args) {
  const readOnly = new Set(['status', 'diff', 'log', 'rev-parse', 'merge-base']);
  invariant(Array.isArray(args) && args.length > 0 &&
    (readOnly.has(args[0]) || (args[0] === 'worktree' && args[1] === 'list')),
    'Worktree Switcher only runs read-only Git queries.');
  try {
    // Avoid index locks and external diff tools during background queries.
    const safeArgs = args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...args.slice(1)] : args;
    const { stdout } = await execFileP('git', ['--no-optional-locks', ...safeArgs], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error((err.stderr || '').trim() || err.message, { cause: err });
  }
}

// Parses `git worktree list --porcelain` output into worktree objects.
function parseWorktrees(output) {
  return output
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const wt = {};
      for (const line of block.split('\n')) {
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (key === 'worktree') wt.path = value;
        else if (key === 'HEAD') wt.head = value;
        else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
        else if (key === 'bare') wt.bare = true;
        else if (key === 'locked') wt.locked = true;
        else if (key === 'prunable') wt.prunable = true;
      }
      return wt;
    })
    .filter((wt) => wt.path);
}

// All parsed git output uses -z (NUL-separated): git C-quotes paths with
// spaces/non-ASCII in newline mode, which corrupts every downstream path use.

// Parses `git diff --name-status -z` output; renames report the new path.
function parseNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      changes.push({ status, path: tokens[i + 2] }); // src, then dst
      i += 2;
    } else {
      changes.push({ status, path: tokens[i + 1] });
      i += 1;
    }
  }
  return changes.filter((c) => c.path);
}

// Parses `git status --porcelain -z` into {xy, path} entries.
function parseStatusZ(statusOut) {
  const tokens = statusOut.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    entries.push({ xy, path: t.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // skip the following orig-path token
  }
  return entries;
}

// Untracked entries from `git status --porcelain -z`, rendered as status '?'.
function parseUntracked(statusOut) {
  return parseStatusZ(statusOut)
    .filter((e) => e.xy === '??')
    .map((e) => ({ status: '?', path: e.path }));
}

// Union of diff changes and untracked entries; diff status wins on collision.
function unionChanges(diffChanges, untracked) {
  const seen = new Set(diffChanges.map((c) => c.path));
  return diffChanges.concat(untracked.filter((u) => !seen.has(u.path)));
}

function relativeTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readWorktreeFile(root, file) {
  invariant(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file),
    'Preview paths must be relative to the selected worktree.');
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, file);
  invariant(within(realRoot, candidate), 'The preview path escapes its worktree.');
  const realFile = fs.realpathSync(candidate);
  invariant(within(realRoot, realFile), 'The preview symlink escapes its worktree.');
  return fs.readFileSync(realFile, 'utf8');
}

// Worktrees keep their own files. Switching opens the corresponding vault;
// it never checks out a branch or copies note contents between worktrees.
// A cached source path remains usable after external cleanup removes its folder.
// Resolve the surviving ancestor so symlinks cannot bypass containment checks.
function realpathWithMissingTail(value) {
  try { return fs.realpathSync(value); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    invariant(parent !== value, 'Cannot resolve the source vault path.');
    return path.join(realpathWithMissingTail(parent), path.basename(value));
  }
}

function resolveWorktreeVault(sourceVault, sourceWorktree, targetWorktree, { allowMissingSource = false } = {}) {
  for (const value of [sourceVault, sourceWorktree, targetWorktree]) {
    invariant(typeof value === 'string' && path.isAbsolute(value), 'Vault and worktree paths must be absolute.');
  }
  const source = allowMissingSource ? realpathWithMissingTail(sourceWorktree) : fs.realpathSync(sourceWorktree);
  const vault = allowMissingSource ? realpathWithMissingTail(sourceVault) : fs.realpathSync(sourceVault);
  const target = fs.realpathSync(targetWorktree);
  invariant(within(source, vault), 'The current vault is outside the selected repository.');
  const targetVault = path.join(target, path.relative(source, vault));
  invariant(fs.existsSync(targetVault) && fs.statSync(targetVault).isDirectory(),
    `This worktree does not contain a vault at ${targetVault}.`);
  invariant(within(target, fs.realpathSync(targetVault)), 'The target vault points outside its worktree.');
  return fs.realpathSync(targetVault);
}

// Obsidian's desktop adapter has no public root-switch API. Keep these private
// calls together, validate their shape before touching the current vault, and
// reconcile through its own filesystem events so core views see the same files.
const WORKTREE_ROOT = Symbol.for('worktree-switcher.root-routing');

function assertSwitchableAdapter(adapter, metadataCache) {
  for (const method of ['getBasePath', 'getFullRealPath', 'queue', 'stopWatch',
    'startWatchPath', 'watchHiddenRecursive', 'reconcileFile', 'reconcileDeletion']) {
    invariant(typeof adapter[method] === 'function', `This Obsidian version cannot switch in place: missing adapter.${method}.`);
  }
  invariant(typeof adapter.basePath === 'string' && adapter.basePath === adapter.getBasePath(), 'Unsupported desktop adapter root.');
  invariant(adapter.files && typeof adapter.handler === 'function', 'The vault filesystem is not ready.');
  invariant(metadataCache && typeof metadataCache.workQueue?.queue === 'function' &&
    typeof metadataCache.saveFileCache === 'function', 'This Obsidian version cannot refresh the metadata index in place.');
}

async function scanWorktreeVault(root) {
  root = await fs.promises.realpath(root);
  const entries = new Map();
  async function visit(relative, ancestors) {
    const absolute = path.join(root, relative);
    const real = await fs.promises.realpath(absolute);
    invariant(real === root || real.startsWith(root + path.sep), `A vault symlink escapes its worktree: ${relative}`);
    const stat = await fs.promises.stat(absolute);
    const normalized = relative.replace(/[\u00a0\u202f]/g, ' ').normalize('NFC');
    invariant(!entries.has(normalized), `Two vault paths normalize to the same name: ${relative}`);
    invariant(stat.isFile() || stat.isDirectory(), `Unsupported vault entry: ${relative}`);
    if (relative) entries.set(normalized, { raw: relative, type: stat.isDirectory() ? 'folder' : 'file' });
    if (stat.isDirectory()) {
      invariant(!ancestors.has(real), `A vault symlink forms a loop: ${relative}`);
      const next = new Set([...ancestors, real]);
      for (const name of (await fs.promises.readdir(absolute)).sort()) {
        if (!name.startsWith('.')) await visit(relative ? relative + '/' + name : name, next);
      }
    }
  }
  await visit('', new Set());
  return entries;
}

function pinWorktreeConfig(adapter, configDir) {
  invariant(typeof configDir === 'string' && configDir.startsWith('.') && configDir !== '.' && configDir !== '..' && !configDir.includes('/') && !configDir.includes('\\'), 'Unsupported vault configuration folder.');
  if (adapter[WORKTREE_ROOT]) {
    invariant(adapter[WORKTREE_ROOT].configDir === configDir, 'The vault configuration folder changed. Restart Obsidian before switching.');
    return;
  }
  const original = adapter.getFullRealPath;
  const state = { home: adapter.getBasePath(), configDir };
  adapter.getFullRealPath = function (relative) {
    const clean = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean === configDir || clean.startsWith(configDir + '/')) {
      const destination = path.resolve(state.home, clean);
      invariant(destination === path.join(state.home, configDir) || destination.startsWith(path.join(state.home, configDir) + path.sep), 'Configuration path escapes its folder.');
      return destination;
    }
    return original.call(this, relative);
  };
  adapter[WORKTREE_ROOT] = state;
}

async function reconcileWorktreeRoot(adapter, vault, metadataCache, root, entries, handler) {
  adapter.stopWatch();
  adapter.basePath = root;
  adapter.handler = handler;
  // Remove absent entries and type changes, children first. These events only
  // update Obsidian's in-memory tree; no file is deleted from either worktree.
  const removed = Object.keys(adapter.files).filter((name) => name !== '/' &&
    !isHiddenPath(name) &&
    (!entries.has(name) || entries.get(name).type !== adapter.files[name].type));
  for (const name of removed.sort((a, b) => b.length - a.length)) {
    await adapter.reconcileDeletion(adapter.files[name]?.realpath || name, name, true);
  }
  // Invalidate metadata even when two branch versions have identical mtimes and
  // sizes. External tools may preserve both while changing the actual contents.
  for (const [name, entry] of entries) {
    if (entry.type === 'file') {
      metadataCache.saveFileCache(name, null);
      if (adapter.files[name]?.type === 'file') adapter.files[name].mtime = -1;
    }
  }
  await adapter.startWatchPath('/');
  for (const [name, entry] of entries) await adapter.reconcileFile(entry.raw, name, true);
  await adapter.watchHiddenRecursive(vault.configDir);
  const actual = new Set(vault.getFiles().map((file) => file.path));
  const expected = [...entries].filter(([, entry]) => entry.type === 'file').map(([name]) => name);
  invariant(actual.size === expected.length && expected.every((name) => actual.has(name)), 'The worktree file tree did not refresh completely.');
}

async function rebaseWorktreeVault(vault, metadataCache, destination) {
  const adapter = vault.adapter;
  assertSwitchableAdapter(adapter, metadataCache);
  const target = await fs.promises.realpath(destination);
  const before = adapter.getBasePath();
  invariant(target !== before, 'This worktree is already open.');
  const nextEntries = await scanWorktreeVault(target);
  let previousEntries;
  try { previousEntries = await scanWorktreeVault(before); } catch (error) {
    if (error.code !== 'ENOENT' || fs.existsSync(before)) throw error;
    previousEntries = null;
  }
  const handler = adapter.handler;
  pinWorktreeConfig(adapter, vault.configDir);
  adapter.stopWatch();
  // Finish source writes and metadata reads before redirecting any paths. Never
  // wait for metadata from inside the filesystem queue: it reads via that queue.
  try {
    await adapter.queue(async () => {});
    await metadataCache.workQueue.queue(async () => {});
    await adapter.queue(() => reconcileWorktreeRoot(adapter, vault, metadataCache, target, nextEntries, handler));
  } catch (error) {
    if (!previousEntries) {
      // Restore the routing identity so another recovery attempt is possible,
      // without recreating a deleted worktree or writing into the destination.
      adapter.stopWatch();
      adapter.basePath = before;
      adapter.handler = handler;
      throw new Error(`Could not open the target vault. The previous worktree was deleted. ${error.message}`);
    }
    try {
      await adapter.queue(() => reconcileWorktreeRoot(adapter, vault, metadataCache, before, previousEntries, handler));
    } catch (rollbackError) {
      throw new Error(`Worktree switch failed (${error.message}); restoring the previous tree also failed (${rollbackError.message}). Restart this vault before editing.`);
    }
    throw new Error(`Worktree switch failed; restored the previous vault. ${error.message}`);
  }
  await metadataCache.workQueue.queue(async () => {});
  return target;
}

async function preserveDeletedWorktreeBuffers(vault, tabs, sourceVault) {
  const recovered = tabs.map(({ leaf, file }) => {
    invariant(typeof leaf.view.editor?.getValue === 'function',
      'The current worktree was deleted. Save open non-text files before switching.');
    return { file, content: leaf.view.editor.getValue() };
  });
  const configHome = vault.adapter[WORKTREE_ROOT]?.home;
  invariant(configHome && fs.existsSync(configHome), 'Cannot locate a surviving configuration folder for editor recovery.');
  const recoveryDir = path.join(configHome, vault.configDir, 'worktree-recovery');
  await fs.promises.mkdir(recoveryDir, { recursive: true });
  const recoveryFile = path.join(recoveryDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.promises.writeFile(recoveryFile, JSON.stringify({ sourceVault, recovered }, null, 2), { flag: 'wx' });
  return recoveryFile;
}

function isHiddenPath(file) {
  return file.split('/').some((part) => part.startsWith('.'));
}

if (!obsidian) {
  module.exports = {
    git, parseNameStatus, parseStatusZ, unionChanges, readWorktreeFile,
    resolveWorktreeVault, isHiddenPath, preserveDeletedWorktreeBuffers,
    scanWorktreeVault, rebaseWorktreeVault,
  };
  return;
}

// ---------------- Obsidian layer ----------------

const { Plugin, ItemView, PluginSettingTab, Setting, SuggestModal, Events, MarkdownRenderer, Notice, setIcon, addIcon } = obsidian;

const ICON_ID = 'worktree-switcher';
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 18v70M80 12v70"/>
    <circle cx="20" cy="12" r="6"/>
    <circle cx="80" cy="88" r="6"/>
    <path d="M29 37h42m-12-11 12 11-12 11M71 63H29m12-11-12 11 12 11"/>
  </g>
</svg>`;

const VIEW_TYPE = 'worktree-switcher-view';
const FILE_VIEW_TYPE = 'worktree-switcher-file-view';
const POLL_MS = 4000;

class WorktreeStore extends Events {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.subscribers = 0;
    this.intervalId = null;
    this.state = null;
    this.slices = new Map();
    this.staleSince = null;
    this.lastError = null;
    this.repositoryPath = null;
    this.baseShaCache = new Map(); // `${wtHead}:${mainHead}` -> merge-base sha
    this.freshCache = new Map();   // headSha -> commit time ms
  }

  repoPath() {
    const configured = this.plugin.settings.repoPath.trim();
    return configured || this.repositoryPath || this.plugin.app.vault.adapter.getBasePath();
  }

  // Refcounted lifecycle: polls only while a panel or file tab is open.
  acquire() { if (++this.subscribers === 1) this.start(); }
  release() { this.subscribers = Math.max(0, this.subscribers - 1); if (this.subscribers === 0) this.stop(); }

  start() {
    this.refresh();
    this.intervalId = window.setInterval(() => this.refresh(), POLL_MS);
    this.plugin.registerInterval(this.intervalId);
  }

  stop() {
    if (this.intervalId) { window.clearInterval(this.intervalId); this.intervalId = null; }
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce();
    try { return await this.refreshPromise; } finally { this.refreshPromise = null; }
  }

  async refreshOnce() {
    try {
      const repo = this.repoPath();
      const wts = parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']));
      if (!wts.length) throw new Error('no worktrees found');
      const main = wts[0];
      this.repositoryPath = main.path;
      const base = main.branch || 'HEAD';
      const rows = [];
      for (const wt of wts) {
        // Git registrations can outlive external folder deletion.
        if (wt.prunable || !fs.existsSync(wt.path) ||
            (wt.path !== main.path && !wt.bare && !fs.existsSync(path.join(wt.path, '.git')))) continue;
        if (wt.bare) { rows.push({ ...wt, isMain: false, changes: [], slice: wt.path, freshTs: null }); continue; }
        const isMain = wt.path === main.path;
        try {
          const status = await git(wt.path, ['status', '--porcelain', '-z']);
          let baseSha = '';
          if (!isMain && wt.branch) {
            const key = `${wt.head}:${main.head}`;
            if (!this.baseShaCache.has(key)) {
              try {
                this.baseShaCache.set(key, (await git(repo, ['merge-base', base, wt.branch])).trim());
              } catch (error) {
                // Exit 1 means unrelated histories. Compare that worktree with its own HEAD.
                if (error.cause?.code !== 1) throw error;
                this.baseShaCache.set(key, null);
              }
            }
            baseSha = this.baseShaCache.get(key);
          }
          const diffTarget = isMain ? 'HEAD' : (baseSha || 'HEAD');
          const diff = parseNameStatus(await git(wt.path, ['diff', '--name-status', '-z', diffTarget]));
          const changes = unionChanges(diff, parseUntracked(status))
            .filter((change) => this.plugin.settings.showHiddenFiles || !isHiddenPath(change.path));
          if (!this.freshCache.has(wt.head)) {
            const ct = parseInt((await git(wt.path, ['log', '-1', '--format=%ct'])).trim(), 10);
            this.freshCache.set(wt.head, Number.isFinite(ct) ? ct * 1000 : null);
          }
          rows.push({
            ...wt, isMain, changes, diffTarget,
            freshTs: this.freshCache.get(wt.head),
            slice: JSON.stringify([wt.head, wt.branch, changes, diffTarget]),
          });
        } catch (error) {
          // Cleanup may race any of the Git queries, not just the first one.
          if (!fs.existsSync(wt.path) || (!isMain && !fs.existsSync(path.join(wt.path, '.git')))) continue;
          throw error;
        }
      }
      invariant(rows.some(row => row.path === main.path), 'The main checkout is unavailable.');

      const changedRows = new Set();
      const newPaths = new Set(rows.map((r) => r.path));
      for (const r of rows) if (this.slices.get(r.path) !== r.slice) changedRows.add(r.path);
      for (const p of this.slices.keys()) if (!newPaths.has(p)) changedRows.add(p);
      this.slices = new Map(rows.map((r) => [r.path, r.slice]));
      this.state = { repo, base, main, worktrees: rows };
      this.plugin.updateWorktreeStatus();

      const wasStale = this.staleSince;
      this.staleSince = null;
      this.lastError = null;
      if (changedRows.size || wasStale) this.trigger('change', changedRows);
      this.trigger('presence'); // Refresh relative times without rebuilding rows.
    } catch (e) {
      // Preserve the last successful state when a query fails.
      this.staleSince = this.staleSince || Date.now();
      this.lastError = e;
      this.trigger('presence');
    }
  }

}

class WorktreeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expandedPaths = new Set();
    this.rowEls = new Map();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Worktree Switcher'; }
  getIcon() { return ICON_ID; }

  async onOpen() {
    const store = this.plugin.store;
    this.registerEvent(store.on('change', (changed) => this.renderRows(changed)));
    this.registerEvent(store.on('presence', () => this.patchPresence()));
    this.renderShell();
    store.acquire();
    if (store.state) this.renderRows(null);
  }

  async onClose() {
    this.plugin.store.release();
  }

  renderShell() {
    const el = this.contentEl;
    el.empty();
    el.addClass('worktree-panel');
    this.rowEls.clear();
    const header = el.createDiv({ cls: 'nav-header worktree-header' });
    this.repoNameEl = header.createSpan({ cls: 'worktree-view-branch' });
    this.liveEl = header.createSpan({ cls: 'worktree-view-fresh' });
    const refreshBtn = header.createEl('button', { cls: 'clickable-icon worktree-icon-button', attr: { 'aria-label': 'Refresh worktrees', title: 'Refresh worktrees' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.onclick = () => this.plugin.store.refresh();
    const controls = el.createDiv({ cls: 'worktree-switch-controls' });
    controls.createEl('label', { text: 'Viewing', attr: { for: 'worktree-vault-picker' } });
    this.worktreeSelect = controls.createEl('select', { attr: { id: 'worktree-vault-picker', 'aria-label': 'Switch worktree vault' } });
    this.worktreeSelect.onchange = () => {
      const row = this.plugin.store.state?.worktrees.find((wt) => wt.path === this.worktreeSelect.value);
      if (row) this.plugin.switchWorktree(row).catch((e) => {
        new Notice(e.message);
      }).finally(() => this.renderRows(null));
    };
    this.staleEl = el.createDiv({ cls: 'worktree-stale' });
    this.staleEl.hide();
    this.listEl = el.createDiv();
    this.footerEl = el.createDiv({ cls: 'worktree-footer' });
  }

  renderRows(changedRows) {
    const state = this.plugin.store.state;
    if (!state) return;
    this.repoNameEl.setText(path.basename(state.repo));
    this.repoNameEl.setAttribute('title', path.basename(state.repo));
    this.worktreeSelect.empty();
    for (const row of state.worktrees.filter((wt) => !wt.bare)) {
      this.worktreeSelect.createEl('option', { text: row.branch || `Detached ${row.head.slice(0, 8)}`, value: row.path });
    }
    this.worktreeSelect.value = this.plugin.currentWorktreePath;
    const keep = new Set();
    for (const row of state.worktrees) {
      keep.add(row.path);
      let elInfo = this.rowEls.get(row.path);
      if (!elInfo || !changedRows || changedRows.has(row.path)) {
        const rowEl = elInfo ? elInfo.rowEl : this.listEl.createDiv({ cls: 'worktree-view-item' });
        rowEl.empty();
        elInfo = this.buildRow(rowEl, row, state);
        this.rowEls.set(row.path, elInfo);
      } else {
        elInfo.row = row;
      }
      this.listEl.appendChild(elInfo.rowEl); // appendChild keeps/repairs ordering
    }
    for (const [p, info] of this.rowEls) {
      if (!keep.has(p)) { info.rowEl.remove(); this.rowEls.delete(p); }
    }
    this.patchPresence();
  }

  buildRow(rowEl, row, state) {
    const info = { rowEl, row };
    const isCurrent = row.path === this.plugin.currentWorktreePath;
    rowEl.toggleClass('worktree-current', isCurrent);
    const head = rowEl.createDiv({ cls: 'worktree-view-row' });
    head.createSpan({ cls: 'worktree-chevron', text: this.expandedPaths.has(row.path) ? '▾' : '▸' });
    const label = row.bare ? '(bare)' : row.branch || `(detached @ ${(row.head || '').slice(0, 8)})`;
    const branchEl = head.createSpan({ cls: 'worktree-view-branch', text: row.locked ? `${label} [locked]` : label });
    branchEl.setAttribute('title', branchEl.textContent);
    const folderBtn = head.createEl('button', { cls: 'clickable-icon worktree-icon-button', attr: { title: 'Reveal in system file explorer' } });
    setIcon(folderBtn, 'folder-open');
    folderBtn.setAttribute('aria-label', 'Reveal in system file explorer');
    folderBtn.onclick = (ev) => { ev.stopPropagation(); require('electron').shell.openPath(row.path); };
    const pathEl = rowEl.createDiv({ cls: 'worktree-view-meta' });
    pathEl.setAttribute('title', row.path);
    const directoryName = path.basename(row.path);
    pathEl.createSpan({ cls: 'worktree-path-parent', text: row.path.slice(0, row.path.length - directoryName.length) });
    pathEl.createSpan({ cls: 'worktree-path-name', text: directoryName });
    const actions = rowEl.createDiv({ cls: 'worktree-view-actions' });
    if (!row.bare) {
      const switchBtn = actions.createEl('button', { cls: 'clickable-icon worktree-icon-button worktree-switch-button' });
      setIcon(switchBtn, isCurrent ? 'check' : 'arrow-right-left');
      switchBtn.disabled = isCurrent;
      switchBtn.setAttribute('aria-label', isCurrent ? `Current worktree: ${label}` : `Switch to ${label} worktree`);
      switchBtn.setAttribute('title', switchBtn.getAttribute('aria-label'));
      switchBtn.onclick = async (ev) => {
        ev.stopPropagation();
        switchBtn.disabled = true;
        try { await this.plugin.switchWorktree(row); }
        catch (e) { new Notice(e.message); }
        finally { switchBtn.disabled = isCurrent; }
      };
    }
    info.freshEl = actions.createSpan({ cls: 'worktree-view-fresh' });

    const details = rowEl.createDiv();
    if (this.expandedPaths.has(row.path)) this.buildDetails(details, row, state);
    head.onclick = () => {
      if (this.expandedPaths.has(row.path)) this.expandedPaths.delete(row.path);
      else this.expandedPaths.add(row.path);
      const fresh = this.plugin.store.state.worktrees.find((r) => r.path === row.path) || row;
      rowEl.empty();
      this.rowEls.set(row.path, this.buildRow(rowEl, fresh, this.plugin.store.state));
      this.patchPresence();
    };
    return info;
  }

  buildDetails(el, row, state) {
    if (row.changes.length === 0) {
      el.createDiv({ cls: 'worktree-view-meta', text: row.diffTarget === 'HEAD' ? 'No uncommitted changes.' : `No changes vs ${state.base}.` });
    }
    for (const change of row.changes) {
      const fileRow = el.createDiv({ cls: 'worktree-view-file' });
      fileRow.createSpan({ cls: `worktree-view-status worktree-view-status-${change.status}`, text: change.status });
      fileRow.createSpan({ text: change.path });
      fileRow.onclick = async (ev) => {
        ev.stopPropagation();
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({
          type: FILE_VIEW_TYPE,
          active: true,
          // Untracked files have no diff — open them in preview.
          state: { wtPath: row.path, file: change.path, diffTarget: row.diffTarget, label: row.branch || row.path, mode: change.status === '?' ? 'preview' : 'diff' },
        });
      };
    }

  }

  patchPresence() {
    const store = this.plugin.store;
    const state = store.state;
    if (!state) {
      if (store.staleSince) {
        this.staleEl.setText(`Cannot read repo: ${store.lastError ? store.lastError.message : 'unknown error'}`);
        this.staleEl.show();
      }
      return;
    }
    if (store.staleSince) {
      this.staleEl.setText(`stale since ${relativeTime(Date.now() - store.staleSince)} ago — ${store.lastError ? store.lastError.message : ''}`);
      this.staleEl.show();
      this.liveEl.setText('○ stale');
    } else {
      this.staleEl.hide();
      this.liveEl.setText('● live');
    }
    let files = 0;
    for (const row of state.worktrees) {
      const info = this.rowEls.get(row.path);
      if (!row.isMain) files += row.changes.length;
      if (!info) continue;
      info.freshEl.setText(row.freshTs ? `updated ${relativeTime(Date.now() - row.freshTs)} ago` : '');
    }
    const count = Math.max(0, state.worktrees.length - 1);
    this.footerEl.setText(`${files} file${files === 1 ? '' : 's'} changed across ${count} worktree${count === 1 ? '' : 's'}`);
  }
}

class WorktreeFileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return FILE_VIEW_TYPE; }
  getDisplayText() { return this.state ? `${path.basename(this.state.file)} @ ${this.state.label}` : 'Worktree file'; }
  getIcon() { return 'git-compare'; }

  async onOpen() {
    const store = this.plugin.store;
    store.acquire(); // file tabs keep the poll alive too
    this.registerEvent(store.on('change', (changed) => {
      if (this.state && (!changed || changed.has(this.state.wtPath))) this.render().catch(error => new Notice(error.message));
    }));
  }

  async onClose() {
    this.plugin.store.release();
  }

  async setState(state, result) {
    this.state = state;
    await this.render();
    return super.setState(state, result);
  }

  getState() { return this.state; }

  async render() {
    const el = this.contentEl;
    el.empty();
    const { wtPath, file, mode } = this.state;
    const storeState = this.plugin.store.state;
    const row = storeState ? storeState.worktrees.find((r) => r.path === wtPath) : null;
    if (storeState && !row) {
      el.createDiv({ cls: 'worktree-view-meta', text: 'This worktree no longer exists (merged or removed).' });
      return;
    }
    const diffTarget = (row && row.diffTarget) || this.state.diffTarget || 'HEAD';

    const header = el.createDiv({ cls: 'worktree-file-header' });
    header.createSpan({ cls: 'worktree-view-branch', text: file });
    const toggle = header.createEl('button', { text: mode === 'diff' ? 'Show preview' : 'Show diff' });
    toggle.onclick = () => {
      this.state.mode = mode === 'diff' ? 'preview' : 'diff';
      this.render();
    };

    const body = el.createDiv();
    if (mode === 'diff') {
      let diff;
      try {
        diff = await git(wtPath, ['diff', diffTarget, '--', file]);
      } catch (e) {
        body.createDiv({ cls: 'worktree-view-error', text: e.message });
        return;
      }
      const pre = body.createEl('pre', { cls: 'worktree-diff' });
      for (const line of diff.split('\n')) {
        const cls =
          line.startsWith('+') ? 'worktree-diff-add' :
          line.startsWith('-') ? 'worktree-diff-del' :
          line.startsWith('@@') ? 'worktree-diff-hunk' : '';
        pre.createDiv({ cls, text: line || ' ' });
      }
    } else {
      const abs = path.join(wtPath, file);
      let content;
      try {
        content = readWorktreeFile(wtPath, file);
      } catch (e) {
        body.createDiv({ cls: 'worktree-view-error', text: `Cannot preview ${file}: ${e.message}` });
        return;
      }
      if (file.endsWith('.md')) {
        const md = body.createDiv({ cls: 'markdown-rendered' });
        await MarkdownRenderer.render(this.app, content, md, abs, this);
      } else {
        body.createEl('pre', { cls: 'worktree-diff', text: content });
      }
    }
  }
}

class WorktreeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Repository path')
      .setDesc('Absolute path to the git repository. Leave empty to use the vault folder.')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/repo')
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value.trim();
            this.plugin.store.repositoryPath = null;
            this.plugin.store.baseShaCache.clear();
            this.plugin.store.freshCache.clear();
            await this.plugin.saveData(this.plugin.settings);
            await this.plugin.store.refresh();
          })
      );
    new Setting(this.containerEl)
      .setName('Show hidden files')
      .setDesc('Include dotfiles and hidden folders, including vault settings, in changed-file lists.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showHiddenFiles).onChange(async (value) => {
        this.plugin.settings.showHiddenFiles = value;
        await this.plugin.saveData(this.plugin.settings);
        await this.plugin.store.refresh();
      }));
  }
}

class WorktreePicker extends SuggestModal {
  constructor(app, plugin, rows) {
    super(app);
    this.plugin = plugin;
    this.rows = rows.filter((row) => !row.bare);
    this.setPlaceholder('Switch worktree vault…');
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.rows.filter((row) => `${row.branch || ''} ${row.path}`.toLowerCase().includes(q));
  }

  renderSuggestion(row, el) {
    el.createDiv({ text: `${row.branch || 'Detached HEAD'}${row.path === this.plugin.currentWorktreePath ? ' · Current' : ''}` });
    el.createDiv({ cls: 'worktree-view-meta', text: row.path });
  }

  onChooseSuggestion(row) {
    this.plugin.switchWorktree(row).catch((e) => new Notice(e.message));
  }
}

module.exports = class WorktreeSwitcherPlugin extends Plugin {
  async onload() {
    addIcon(ICON_ID, ICON_SVG);
    this.settings = Object.assign({ repoPath: '', showHiddenFiles: false }, await this.loadData());
    this.switching = false;
    this.worktreeTabs = new Map();
    this.registerDomEvent(document, 'keydown', (event) => {
      if (this.switching) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    this.currentWorktreePath = null;
    try {
      this.currentWorktreePath = fs.realpathSync((await git(this.app.vault.adapter.getBasePath(), ['rev-parse', '--show-toplevel'])).trim());
    } catch (_) { /* The panel reports an unavailable repository until metadata arrives. */ }
    this.store = new WorktreeStore(this);

    this.registerView(VIEW_TYPE, (leaf) => new WorktreeView(leaf, this));
    this.registerView(FILE_VIEW_TYPE, (leaf) => new WorktreeFileView(leaf, this));
    this.addSettingTab(new WorktreeSettingTab(this.app, this));

    this.addRibbonIcon(ICON_ID, 'Switch Worktrees', () => this.activateView());
    this.addCommand({
      id: 'open-worktree-view',
      name: 'Switch Worktrees',
      icon: ICON_ID,
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'switch-worktree-vault',
      name: 'Switch worktree in this window',
      callback: () => this.showWorktreePicker().catch((e) => new Notice(e.message)),
    });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable', 'worktree-status-switcher');
    this.statusEl.setAttribute('role', 'button');
    this.statusEl.setAttribute('tabindex', '0');
    this.statusEl.setAttribute('aria-label', 'Switch worktree vault');
    this.registerDomEvent(this.statusEl, 'click', () => this.showWorktreePicker().catch((e) => new Notice(e.message)));
    this.registerDomEvent(this.statusEl, 'keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.showWorktreePicker().catch((e) => new Notice(e.message));
      }
    });
    this.updateWorktreeStatus();
    await this.store.refresh();
  }

  onunload() {
    this.store.stop();
  }

  updateWorktreeStatus() {
    if (!this.statusEl) return;
    const current = this.store.state?.worktrees.find((row) => row.path === this.currentWorktreePath);
    const missing = !fs.existsSync(this.app.vault.adapter.getBasePath());
    this.statusEl.setText(missing ? 'Worktree deleted · choose another ▾' :
      current ? `Worktree: ${current.branch || 'Detached HEAD'} ▾` : 'Switch worktree ▾');
    this.statusEl.setAttribute('title', `Switch this window’s notes and file tree to another worktree.\n${this.app.vault.adapter.getBasePath()}`);
  }

  async showWorktreePicker() {
    await this.store.refresh();
    invariant(this.store.state && !this.store.staleSince, this.store.lastError?.message || 'Cannot read the repository.');
    new WorktreePicker(this.app, this, this.store.state.worktrees).open();
  }

  async switchWorktree(row) {
    invariant(!this.switching, 'A worktree switch is already in progress.');
    this.switching = true;
    document.body.addClass('worktree-is-switching');
    const progress = new Notice('Switching worktree in this window…', 0);
    try {
      const sourceVault = this.app.vault.adapter.getBasePath();
      // Never spawn Git in a folder that external cleanup may have removed.
      const sourceWorktree = this.currentWorktreePath ||
        fs.realpathSync((await git(sourceVault, ['rev-parse', '--show-toplevel'])).trim());
      await this.store.refresh();
      invariant(this.store.state && !this.store.staleSince, 'Refresh the worktree list before switching.');
      const target = this.store.state.worktrees.find((wt) => wt.path === row.path && !wt.bare);
      invariant(target, 'This worktree no longer exists.');
      invariant(fs.existsSync(target.path), 'The selected worktree was deleted. Choose another worktree.');
      if (fs.realpathSync(target.path) === sourceWorktree) return;
      const repository = fs.realpathSync(this.store.repoPath());
      const [sourceCommon, targetCommon] = await Promise.all([
        git(repository, ['rev-parse', '--git-common-dir']),
        git(target.path, ['rev-parse', '--git-common-dir']),
      ]);
      invariant(fs.realpathSync(path.resolve(repository, sourceCommon.trim())) ===
        fs.realpathSync(path.resolve(target.path, targetCommon.trim())), 'The target belongs to a different repository.');
      assertSwitchableAdapter(this.app.vault.adapter, this.app.metadataCache);
      const targetVault = resolveWorktreeVault(sourceVault, sourceWorktree, target.path, { allowMissingSource: true });
      await scanWorktreeVault(targetVault);
      const tabs = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.file) tabs.push({ leaf, state: leaf.getViewState(), file: leaf.view.file.path });
      });
      this.worktreeTabs.set(sourceVault, tabs);
      const restoreTabs = this.worktreeTabs.get(targetVault) || tabs;
      const activeLeaf = this.app.workspace.activeLeaf;
      if ((!fs.existsSync(sourceVault) || !fs.existsSync(path.join(sourceWorktree, '.git'))) && tabs.length) {
        // Save open editor buffers outside the vanished worktree before clearing
        // any tabs. Never resurrect deleted notes through delayed autosaves.
        const recoveryFile = await preserveDeletedWorktreeBuffers(this.app.vault, tabs, sourceVault);
        new Notice(`Saved open notes from the deleted worktree to ${recoveryFile}`, 15000);
      } else {
        for (const { leaf } of tabs) {
          if (typeof leaf.view.save === 'function') await leaf.view.save();
          else invariant(leaf.view.getViewType() !== 'markdown', 'Save your open notes before switching.');
        }
      }
      // Unload file editors before redirecting paths, so delayed autosaves cannot
      // put a previous worktree's text into the destination's note.
      const cleared = [];
      try {
        for (const tab of tabs) {
          await tab.leaf.setViewState({ type: 'empty' });
          cleared.push(tab);
        }
        await rebaseWorktreeVault(this.app.vault, this.app.metadataCache, targetVault);
      } catch (error) {
        if (this.app.vault.adapter.getBasePath() === sourceVault) {
          for (const tab of cleared) await tab.leaf.setViewState(tab.state);
        }
        throw error;
      }
      this.currentWorktreePath = fs.realpathSync(target.path);
      this.updateWorktreeStatus();
      this.store.trigger('change', null);
      const availableLeaves = new Set();
      this.app.workspace.iterateAllLeaves((leaf) => availableLeaves.add(leaf));
      for (const tab of restoreTabs) {
        if (availableLeaves.has(tab.leaf) && this.app.vault.getFileByPath(tab.file)) await tab.leaf.setViewState(tab.state);
      }
      if (activeLeaf) this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
      this.app.workspace.trigger('file-open', this.app.workspace.getActiveFile());
      new Notice(`Viewing ${target.branch || 'detached worktree'} in this window`);
    } finally {
      progress.hide();
      document.body.removeClass('worktree-is-switching');
      this.switching = false;
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = existing[0] || this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
