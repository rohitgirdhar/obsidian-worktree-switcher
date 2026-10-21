"use strict";
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const versions = require('../versions.json');
assert.match(manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.ok(!manifest.id.includes('obsidian'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, pkg.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.author, 'Rohit Girdhar');
assert.equal(manifest.authorUrl, 'https://github.com/rohitgirdhar');
assert.equal(manifest.isDesktopOnly, true);
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
for (const name of ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE', 'README.md']) {
  assert.ok(fs.statSync(path.join(root, name)).size > 0, `${name} is empty`);
}
const code = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
new Function('require', 'module', 'exports', code);
assert.doesNotMatch(code, /\/(?:Users|home)\/[^/\s]+\//, 'Runtime code must not contain personal home paths');
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim();
assert.ok(license.includes('Sebastian Winkler'));
assert.ok(code.includes(license), 'main.js must retain the full license when installed by BRAT');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, manifest.version);
console.log(`Release ${manifest.version} is consistent.`);
