"use strict";
require('./check-release.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const manifest = require('../manifest.json');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const files = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE'];
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  fs.writeFileSync(path.join(dist, file), bytes);
  const name = Buffer.from(`${manifest.id}/${file}`);
  const crc = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x21, 12); // DOS epoch date, deterministic builds.
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x21, 14);
  directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20);
  directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(offset, 42);
  local.push(header, name, bytes); central.push(directory, name);
  offset += header.length + name.length + bytes.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = `worktree-switcher-${manifest.version}.zip`;
fs.writeFileSync(path.join(dist, archive), Buffer.concat([...local, directory, end]));
const sums = [...files, archive].map(file => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex')}  ${file}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Packaged ${archive}`);
