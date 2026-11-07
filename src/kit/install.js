'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function readIfExists(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Writes bundled files under `root`. `installed` maps each path to the hash we
// last wrote, which tells our own stale copy from a file the user changed: the
// user's edits and deletions always win. Returns the updated map.
async function installKit(root, files, installed) {
  const next = { ...installed };
  for (const { path: relative, content } of files) {
    const target = path.join(root, relative);
    const current = await readIfExists(target);
    const ours = hashOf(content);
    if (current === content) {
      next[relative] = ours;
    } else if (current === null ? !(relative in installed) : hashOf(current) === installed[relative]) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
      next[relative] = ours;
    }
  }
  return next;
}

module.exports = { installKit };
