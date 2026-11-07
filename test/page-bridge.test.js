'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { handlePageMessage } = require('../src/page-bridge');

const FILE = { basename: 'doc', name: 'doc.html', path: 'dir/doc.html' };

function setup(overrides = {}) {
  const files = new Map([['dir/doc.comments.json', '{}']]);
  const adapter = {
    exists: async (p) => files.has(p),
    read: async (p) => files.get(p),
    write: async (p, c) => { files.set(p, c); },
    ...overrides,
  };
  const prefs = new Map();
  const storage = { getItem: (k) => prefs.get(k) ?? null, setItem: (k, v) => prefs.set(k, v) };
  return { files, adapter, storage };
}

async function send(s, data, file = FILE) {
  const replies = [];
  await handlePageMessage({ channel: 'comments', file: 'doc.comments.json', reqId: 'r', ...data }, file, s.adapter, s.storage, (m) => replies.push(m));
  return replies[0];
}

test('ignores other channels, replies and empty data', async () => {
  const s = setup();
  const replies = [];
  const respond = (m) => replies.push(m);
  await handlePageMessage(null, FILE, s.adapter, s.storage, respond);
  await handlePageMessage({ channel: 'other' }, FILE, s.adapter, s.storage, respond);
  await handlePageMessage({ channel: 'comments', reply: true }, FILE, s.adapter, s.storage, respond);
  assert.deepEqual(replies, []);
});

test('refuses any file but the neighbour', async () => {
  const s = setup();
  const reply = await send(s, { op: 'read', file: '../secret.md' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Only doc\.comments\.json/);
});

test('ping answers with the stored theme', async () => {
  const s = setup();
  assert.equal((await send(s, { op: 'ping' })).theme, null);
  await send(s, { op: 'theme', theme: 'dark' });
  const reply = await send(s, { op: 'ping' });
  assert.deepEqual([reply.ok, reply.theme, reply.reqId, reply.reply], [true, 'dark', 'r', true]);
});

test('refuses an unknown theme', async () => {
  const s = setup();
  assert.equal((await send(s, { op: 'theme', theme: 'neon' })).ok, false);
});

test('reads the neighbour, or null when it does not exist', async () => {
  const s = setup();
  assert.equal((await send(s, { op: 'read' })).content, '{}');
  s.files.clear();
  assert.equal((await send(s, { op: 'read' })).content, null);
});

test('writes next to the page, also in the vault root', async () => {
  const s = setup();
  await send(s, { op: 'write', content: 'x' });
  assert.equal(s.files.get('dir/doc.comments.json'), 'x');
  await send(s, { op: 'write', content: 'y' }, { basename: 'doc', name: 'doc.html', path: 'doc.html' });
  assert.equal(s.files.get('doc.comments.json'), 'y');
});

test('refuses a write without text and an unknown operation', async () => {
  const s = setup();
  assert.equal((await send(s, { op: 'write', content: 1 })).ok, false);
  assert.match((await send(s, { op: 'delete' })).error, /Unsupported operation/);
});

test('reports an adapter failure to the page', async () => {
  const s = setup({ read: async () => { throw new Error('disk'); } });
  assert.equal((await send(s, { op: 'read' })).error, 'disk');
});
