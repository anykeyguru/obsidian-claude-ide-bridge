'use strict';

const { settle } = require('./support/setup');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const obsidian = require('./support/obsidian');
const ClaudeIdeBridge = require('../src/main');
const { formatFor } = require('../src/formats');
const { TEXT_VIEW, BINARY_VIEW } = require('../src/view-types');

const { FileSystemAdapter, TFile, Notice } = obsidian;

let plugin;
let vault;
let handlers;

function makeApp(overrides = {}) {
  handlers = { all: {} };
  const leaves = [];
  const adapter = new FileSystemAdapter(vault);
  return {
    leaves,
    vault: { adapter, getAbstractFileByPath: () => null, on: () => () => {} },
    workspace: {
      on(name, handler) { handlers[name] = handler; (handlers.all[name] = handlers.all[name] || []).push(handler); return () => {}; },
      iterateAllLeaves: (f) => leaves.forEach(f),
      getMostRecentLeaf: () => null,
      getActiveFile: () => null,
      getLeaf: () => ({ setViewState: async (state) => { handlers.opened = state; } }),
      activeLeaf: null,
    },
    ...overrides,
  };
}

function client() {
  const sent = [];
  return { sent, congested: false, sendEncoded: (b) => sent.push(JSON.parse(b.toString())), close() { this.closed = true; } };
}

const start = async (app = makeApp()) => {
  plugin = new ClaudeIdeBridge(app, { version: '1.2.3' });
  await plugin.onload();
  await plugin.installKit();
  plugin.fileMenuHandlers = handlers.all['file-menu'];
  return plugin;
};

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cib-vault-'));
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cib-config-'));
  Notice.shown.length = 0;
});

afterEach(() => {
  if (plugin) {
    plugin.onunload();
    plugin.teardown();
    plugin = null;
  }
});

const view = (type, name, extra = {}) => {
  const v = {
    file: new TFile(name),
    getViewType: () => type,
    containerEl: document.createElement('div'),
    ...extra,
  };
  v.leaf = { view: v };
  return v;
};

test('refuses a vault that is not on disk', async () => {
  const app = makeApp();
  app.vault.adapter = {};
  plugin = new ClaudeIdeBridge(app, { version: '1' });
  await plugin.onload();
  assert.match(Notice.shown[0], /desktop only/);
  plugin.onunload();
  plugin = null;
});

test('starts the server, writes the lock and installs the kit', async () => {
  await start();
  const lock = path.join(process.env.CLAUDE_CONFIG_DIR, 'ide', `${plugin.port}.lock`);
  assert.ok(fs.existsSync(lock));
  assert.equal(process.env.CLAUDE_CODE_SSE_PORT, String(plugin.port));
  assert.ok(fs.existsSync(path.join(vault, '.claude/skills/html-review-doc/SKILL.md')));
  assert.ok(fs.existsSync(path.join(vault, '.claude/skills/html-review-doc/template.html')));
  assert.equal(plugin.mcpHost.version, '1.2.3');
});

test('registers every extension with its view and survives a taken one', async () => {
  const app = makeApp({ taken: ['csv'] });
  await start(app);
  assert.equal(plugin.extensions.json, TEXT_VIEW);
  assert.equal(plugin.extensions.safetensors, BINARY_VIEW);
  assert.equal(plugin.extensions.csv, undefined);
});

test('views are created by the registered factories', async () => {
  await start();
  const leaf = { app: plugin.app };
  assert.equal(plugin.views[TEXT_VIEW](leaf).getViewType(), TEXT_VIEW);
  assert.equal(plugin.views[BINARY_VIEW](leaf).getViewType(), BINARY_VIEW);
});

test('a kit failure does not stop the plugin', async () => {
  await start();
  const { warn } = console;
  console.warn = () => {};
  plugin.basePath = '/dev/null/nope';
  plugin.settings.kit = {};
  await plugin.installKit();
  console.warn = warn;
});

test('onunload cleans up everything', async () => {
  await start();
  const c = client();
  plugin.clients.add(c);
  const lock = path.join(process.env.CLAUDE_CONFIG_DIR, 'ide', `${plugin.port}.lock`);
  plugin.onunload();
  plugin.teardown();
  plugin = null;
  assert.equal(c.closed, true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(process.env.CLAUDE_CODE_SSE_PORT, undefined);
});

test('file menu and command open supported files in the right view', async () => {
  await start();
  const items = [];
  const item = {
    setTitle() { return this; }, setIcon() { return this; }, onClick(f) { items.push(f); return this; },
  };
  const menu = { addItem: (f) => f(item) };
  const [openMenu] = plugin.fileMenuHandlers;
  openMenu(menu, new TFile('a.txt.nope'));
  openMenu(menu, { extension: 'json' });
  assert.equal(items.length, 0);
  openMenu(menu, new TFile('m.safetensors'));
  items[0]();
  assert.equal(handlers.opened.type, BINARY_VIEW);
  const command = plugin.commands.find((c) => c.id === 'open-in-bridge');
  assert.equal(command.checkCallback(true), false);
  plugin.app.workspace.getActiveFile = () => new TFile('a.nope');
  assert.equal(command.checkCallback(true), false);
  plugin.app.workspace.getActiveFile = () => new TFile('a.json');
  assert.equal(command.checkCallback(true), true);
  command.checkCallback(false);
  assert.equal(handlers.opened.type, TEXT_VIEW);
});

test('page messages reach only the owner of the frame', async () => {
  await start();
  const source = { posted: [], postMessage(m) { this.posted.push(m); } };
  const other = view(TEXT_VIEW, 'x.html');
  const owner = view(TEXT_VIEW, 'doc.html', { format: formatFor('html'), renderer: { frame: { contentWindow: source } } });
  plugin.app.leaves.push({ view: other }, { view: owner });
  plugin.onPageMessage({ data: { channel: 'comments', op: 'ping', file: 'doc.comments.json', reqId: 1 }, source });
  await settle();
  assert.equal(source.posted[0].ok, true);
  source.posted.length = 0;
  plugin.onPageMessage({ data: { channel: 'comments', op: 'ping', file: 'doc.comments.json' }, source: {} });
  plugin.onPageMessage({ data: null, source });
  plugin.onPageMessage({ data: {} });
  await settle();
  assert.deepEqual(source.posted, []);
});

test('a page without the bridge flag cannot use the channel', async () => {
  await start();
  const source = { postMessage() { assert.fail('must not answer'); } };
  const owner = view(TEXT_VIEW, 'd.mmd', { format: formatFor('mermaid'), renderer: { frame: { contentWindow: source } } });
  plugin.app.leaves.push({ view: owner });
  plugin.onPageMessage({ data: { channel: 'comments', op: 'ping', file: 'd.comments.json' }, source });
  await settle();
});

test('a page reports its selection, and clearing it forgets it', async () => {
  await start();
  const source = {};
  const owner = view(TEXT_VIEW, 'doc.html', { format: {}, renderer: { frame: { contentWindow: source } } });
  plugin.app.leaves.push({ view: owner });
  plugin.onPageMessage({ data: { frameSelection: 'picked' }, source });
  assert.deepEqual(plugin.domSel, { path: 'doc.html', text: 'picked', pageStart: 1, pageEnd: 1 });
  plugin.onPageMessage({ data: { frameSelection: ' ' }, source });
  assert.equal(plugin.domSel, null);
});

test('clearing a selection of another file keeps the current one', async () => {
  await start();
  plugin.setSelection('a', 'x');
  plugin.setSelection('b', '');
  assert.equal(plugin.domSel.path, 'a');
});

test('currentView prefers the active, then the last, then the recent view', async () => {
  await start();
  assert.equal(plugin.currentView(), null);
  const a = view('markdown', 'a.md');
  plugin.app.workspace.activeLeaf = a.leaf;
  assert.equal(plugin.currentView(), a);
  plugin.app.workspace.activeLeaf = { view: { getViewType: () => 'graph' } };
  assert.equal(plugin.currentView(), a);
  a.leaf.view = null;
  const b = view('pdf', 'b.pdf');
  plugin.app.workspace.getMostRecentLeaf = () => b.leaf;
  assert.equal(plugin.currentView(), b);
});

test('active leaf changes update the last view', async () => {
  await start();
  const a = view('markdown', 'a.md');
  handlers['active-leaf-change'](a.leaf);
  assert.equal(plugin.lastView, a);
  handlers['active-leaf-change'](null);
  assert.equal(plugin.lastView, a);
  assert.ok(plugin.schedulePush.calls >= 2);
});

function markdownView(selected = 'sel') {
  return view('markdown', 'a.md', {
    editor: {
      getCursor: (which) => (which === 'from' ? { line: 1, ch: 2 } : { line: 3, ch: 4 }),
      getSelection: () => selected,
    },
  });
}

test('snapshot reads the Markdown editor', async () => {
  await start();
  const a = markdownView();
  plugin.app.workspace.activeLeaf = a.leaf;
  const snap = plugin.snapshot();
  assert.equal(snap.text, 'sel');
  assert.deepEqual(snap.selection.end, { line: 3, character: 4 });
  assert.equal(snap.filePath, `${vault}/a.md`);
});

test('snapshot of a DOM view uses the remembered selection of that file', async () => {
  await start();
  const a = view('pdf', 'a.pdf');
  plugin.app.workspace.activeLeaf = a.leaf;
  assert.equal(plugin.snapshot().selection.isEmpty, true);
  plugin.setSelection('a.pdf', 'picked', 2, 4);
  const snap = plugin.snapshot();
  assert.equal(snap.text, 'picked');
  assert.deepEqual([snap.selection.start.line, snap.selection.end.line], [1, 3]);
  plugin.setSelection('other.pdf', 'x');
  assert.equal(plugin.snapshot().text, '');
});

test('snapshot without a view is null and nothing is pushed', async () => {
  await start();
  const c = client();
  plugin.clients.add(c);
  plugin.pushSelection(true);
  assert.deepEqual(c.sent, []);
});

test('with no clients a selection is not even read', async () => {
  await start();
  plugin.snapshot = () => assert.fail('must not read the selection');
  plugin.pushSelection(true);
});

test('pushes a changed selection once, and again when forced', async () => {
  await start();
  const c = client();
  plugin.clients.add(c);
  plugin.app.workspace.activeLeaf = markdownView().leaf;
  plugin.pushSelection(false);
  plugin.pushSelection(false);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].method, 'selection_changed');
  plugin.pushSelection(true);
  assert.equal(c.sent.length, 2);
  assert.equal(plugin.latest.text, 'sel');
});

test('initialized forces a push through the MCP host', async () => {
  await start();
  const c = client();
  plugin.clients.add(c);
  plugin.app.workspace.activeLeaf = markdownView().leaf;
  plugin.mcpHost.onInitialized();
  assert.equal(c.sent.length, 1);
});

test('a congested client is skipped and the others still get the push', async () => {
  await start();
  const stuck = client();
  stuck.congested = true;
  const live = client();
  plugin.clients.add(stuck).add(live);
  plugin.broadcast({ hello: 1 });
  assert.deepEqual([stuck.sent.length, live.sent.length], [0, 1]);
});

test('sendAtMention tells the user when nobody listens', async () => {
  await start();
  const ed = { getCursor: () => ({ line: 5 }) };
  plugin.sendAtMention(ed, null);
  plugin.sendAtMention(ed, { file: new TFile('a.md') });
  assert.match(Notice.shown[0], /no Claude session/);
  const c = client();
  plugin.clients.add(c);
  plugin.sendAtMention(ed, { file: new TFile('a.md') });
  assert.deepEqual(c.sent[0].params, { filePath: `${vault}/a.md`, lineStart: 5, lineEnd: 5 });
});

test('command and editor menu send the mention', async () => {
  await start();
  const calls = [];
  plugin.sendAtMention = (...args) => calls.push(args);
  plugin.commands.find((c) => c.id === 'send-selection').editorCallback('ed', 'view');
  const item = {
    setTitle() { return this; }, setIcon() { return this; }, onClick(f) { f(); return this; },
  };
  handlers['editor-menu']({ addItem: (f) => f(item) }, 'ed2', 'view2');
  assert.deepEqual(calls, [['ed', 'view'], ['ed2', 'view2']]);
});

function domSelection(node, text) {
  return { anchorNode: node, focusNode: node, toString: () => text };
}

test('captureDomSelection stores text with pages and ignores the editor pane', async () => {
  await start();
  const a = view('pdf', 'a.pdf');
  const page = a.containerEl.appendChild(document.createElement('div'));
  page.setAttribute('data-page-number', '3');
  const span = page.appendChild(document.createElement('span'));
  plugin.app.leaves.push({ view: a });
  const original = window.getSelection;
  window.getSelection = () => domSelection(span, 'picked');
  try {
    plugin.scheduleCapture();
    plugin.scheduleCapture.flush();
    assert.deepEqual(plugin.domSel, { path: 'a.pdf', text: 'picked', pageStart: 3, pageEnd: 3 });
    window.getSelection = () => domSelection(span, ' ');
    plugin.captureDomSelection();
    assert.equal(plugin.domSel, null);
  } finally {
    window.getSelection = original;
  }
});

test('captureDomSelection falls back to a shadow root', async () => {
  await start();
  const a = view('pdf', 'a.pdf');
  const hostEl = a.containerEl.appendChild(document.createElement('div'));
  Object.defineProperty(hostEl, 'shadowRoot', { value: { getSelection: () => domSelection(hostEl, 'in shadow') } });
  plugin.app.leaves.push({ view: a });
  const original = window.getSelection;
  window.getSelection = () => domSelection(hostEl, '');
  try {
    plugin.captureDomSelection();
  } finally {
    window.getSelection = original;
  }
  assert.equal(plugin.domSel.text, 'in shadow');
});

test('captureDomSelection skips nodes outside any view, and empty selections', async () => {
  await start();
  plugin.domSel = { path: 'keep' };
  const original = window.getSelection;
  try {
    window.getSelection = () => domSelection(document.createTextNode('x'), 'x');
    plugin.captureDomSelection();
    window.getSelection = () => domSelection(document.createElement('div'), 'x');
    plugin.captureDomSelection();
    window.getSelection = () => null;
    plugin.captureDomSelection();
  } finally {
    window.getSelection = original;
  }
  assert.deepEqual(plugin.domSel, { path: 'keep' });
});

test('captureDomSelection leaves the editor pane alone', async () => {
  await start();
  const editor = document.body.appendChild(document.createElement('textarea'));
  editor.className = 'cib-editor';
  editor.focus();
  plugin.domSel = { path: 'keep' };
  plugin.captureDomSelection();
  editor.remove();
  assert.deepEqual(plugin.domSel, { path: 'keep' });
});

test('DOM events schedule work, and a client socket is tracked', async () => {
  await start();
  const before = plugin.schedulePush.calls;
  document.dispatchEvent(new window.Event('selectionchange'));
  document.dispatchEvent(new window.Event('mouseup'));
  document.dispatchEvent(new window.Event('keyup'));
  assert.equal(plugin.schedulePush.calls, before + 3);
  assert.ok(plugin.scheduleCapture.calls >= 1);
  handlers['editor-change']();
  handlers['file-open']();
  const socket = new EventEmitter();
  socket.setNoDelay = () => {};
  socket.write = () => {};
  socket.end = () => {};
  plugin.addClient(socket);
  assert.equal(plugin.clients.size, 1);
  socket.emit('close');
  assert.equal(plugin.clients.size, 0);
});

test('window messages and beforeunload are wired', async () => {
  await start();
  const seen = [];
  plugin.onPageMessage = (e) => seen.push(e.data);
  window.dispatchEvent(new window.MessageEvent('message', { data: 'x' }));
  assert.deepEqual(seen, ['x']);
  const lock = path.join(process.env.CLAUDE_CONFIG_DIR, 'ide', `${plugin.port}.lock`);
  window.dispatchEvent(new window.Event('beforeunload'));
  assert.equal(fs.existsSync(lock), false);
});

test('Build review page writes the page next to the file and reads the fields file', async () => {
  await start();
  const { adapter } = plugin.app.vault;
  await adapter.write('dir/data.yaml', 'a: 1\n');
  await adapter.write('dir/data.fields.yaml', 'title: Hello\n');
  const file = new TFile('dir/data.yaml');
  await plugin.buildReviewPage(file);
  const page = await adapter.read('dir/data.review.html');
  assert.match(page, /<title>Hello<\/title>/);
  assert.match(Notice.shown.at(-1), /built dir\/data\.review\.html/);
  await adapter.write('dir/data.yaml', 'a: 2\n');
  await plugin.buildReviewPage(file);
  assert.notEqual(await adapter.read('dir/data.review.html'), page);
});

test('Build review page works without a fields file, in the app language', async () => {
  await start();
  const { adapter } = plugin.app.vault;
  await adapter.write('data.json', '{}');
  window.localStorage.setItem('language', 'ru');
  await plugin.buildReviewPage(new TFile('data.json'));
  window.localStorage.removeItem('language');
  assert.match(await adapter.read('data.review.html'), /<html lang="ru">/);
});

test('Build review page reports failures and keeps a page it did not make', async () => {
  await start();
  const { adapter } = plugin.app.vault;
  await adapter.write('data.json', '{oops');
  await plugin.buildReviewPage(new TFile('data.json'));
  assert.match(Notice.shown.at(-1), /JSON/);
  await adapter.write('data.review.html', '<p>mine</p>');
  await adapter.write('data.json', '{}');
  await plugin.buildReviewPage(new TFile('data.json'));
  assert.match(Notice.shown.at(-1), /was not generated/);
  assert.equal(await adapter.read('data.review.html'), '<p>mine</p>');
  await plugin.buildReviewPage(new TFile('huge.json', 9 * 1024 * 1024));
  assert.match(Notice.shown.at(-1), /over 8 MB/);
});

test('the file menu and the command offer Build review page for sources only', async () => {
  await start();
  const built = [];
  plugin.buildReviewPage = async (file) => built.push(file.path);
  const clicks = [];
  const item = {
    setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, onClick(f) { clicks.push([this.title, f]); return this; },
  };
  const menu = { addItem: (f) => f(item) };
  plugin.fileMenuHandlers.forEach((h) => h(menu, new TFile('a.nope')));
  plugin.fileMenuHandlers.forEach((h) => h(menu, { extension: 'sql' }));
  assert.equal(clicks.length, 0);
  plugin.fileMenuHandlers.forEach((h) => h(menu, new TFile('a.sql')));
  clicks.find(([title]) => title === 'Build review page')[1]();
  assert.deepEqual(built, ['a.sql']);
  const command = plugin.commands.find((c) => c.id === 'build-review-page');
  assert.equal(command.checkCallback(true), false);
  plugin.app.workspace.getActiveFile = () => new TFile('a.txt');
  assert.equal(command.checkCallback(true), false);
  plugin.app.workspace.getActiveFile = () => new TFile('a.csv');
  assert.equal(command.checkCallback(true), true);
  command.checkCallback(false);
  assert.deepEqual(built, ['a.sql', 'a.csv']);
});
