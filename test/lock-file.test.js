'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, test } = require('node:test');

const { writeLockFile, removeLockFile, lockPath } = require('../src/lock-file');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cib-lock-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
});

const ide = (name) => path.join(dir, 'ide', name);
const put = (name, value) => {
  fs.mkdirSync(path.join(dir, 'ide'), { recursive: true });
  fs.writeFileSync(ide(name), typeof value === 'string' ? value : JSON.stringify(value));
};

test('writes a private lock file describing the server', () => {
  writeLockFile(1234, '/vault', 'token');
  const lock = JSON.parse(fs.readFileSync(lockPath(1234), 'utf8'));
  assert.deepEqual(lock, {
    pid: process.pid, workspaceFolders: ['/vault'], ideName: 'Obsidian', transport: 'ws', authToken: 'token',
  });
  assert.equal(fs.statSync(lockPath(1234)).mode & 0o777, 0o600);
});

test('removes a lock, and tolerates one already gone', () => {
  writeLockFile(1234, '/vault', 'token');
  removeLockFile(1234);
  assert.equal(fs.existsSync(lockPath(1234)), false);
  removeLockFile(1234);
});

test('cleans dead and same-vault locks, keeps foreign ones', () => {
  put('1.lock', { ideName: 'Obsidian', pid: 2 ** 22 + 1, workspaceFolders: ['/other'] });
  put('2.lock', { ideName: 'Obsidian', pid: process.pid, workspaceFolders: ['/vault'] });
  put('3.lock', { ideName: 'Obsidian', pid: process.pid, workspaceFolders: ['/other'] });
  put('4.lock', { ideName: 'VS Code', pid: 2 ** 22 + 1 });
  put('5.lock', 'not json');
  put('note.txt', 'keep');
  writeLockFile(9, '/vault', 'token');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'ide')).sort(), ['3.lock', '4.lock', '5.lock', '9.lock', 'note.txt']);
});
