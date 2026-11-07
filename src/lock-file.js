'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IDE_NAME = 'Obsidian';

const lockDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide');
const lockPath = (port) => path.join(lockDir(), `${port}.lock`);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function cleanStaleLocks(basePath) {
  let names = [];
  try { names = fs.readdirSync(lockDir()); } catch (e) { return; }
  for (const name of names.filter((n) => n.endsWith('.lock'))) {
    const file = path.join(lockDir(), name);
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (lock.ideName !== IDE_NAME) continue;
      const sameVault = (lock.workspaceFolders || []).includes(basePath);
      if (!isAlive(lock.pid) || (sameVault && lock.pid === process.pid)) fs.unlinkSync(file);
    } catch (e) { /* ignore foreign/broken files */ }
  }
}

function writeLockFile(port, basePath, authToken) {
  fs.mkdirSync(lockDir(), { recursive: true });
  cleanStaleLocks(basePath);
  const lock = {
    pid: process.pid, workspaceFolders: [basePath], ideName: IDE_NAME, transport: 'ws', authToken,
  };
  fs.writeFileSync(lockPath(port), JSON.stringify(lock), { mode: 0o600 });
}

function removeLockFile(port) {
  try { fs.unlinkSync(lockPath(port)); } catch (e) { /* already gone */ }
}

module.exports = { writeLockFile, removeLockFile, lockPath };
