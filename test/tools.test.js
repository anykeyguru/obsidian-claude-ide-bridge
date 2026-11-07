'use strict';

require('./support/setup');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { TOOLS } = require('../src/tools');

const tool = (name) => TOOLS.find((t) => t.name === name);
const markdown = (name) => ({ file: { path: name, name, extension: 'md' }, getViewType: () => 'markdown' });

function editor(content) {
  const calls = {};
  return {
    calls,
    getValue: () => content,
    offsetToPos: (o) => ({ line: 0, ch: o }),
    getLine: () => content,
    setSelection: (from, to) => { calls.selection = [from.ch, to.ch]; },
    scrollIntoView: () => { calls.scrolled = true; },
  };
}

function context(overrides = {}) {
  const opened = [];
  const leaf = { view: markdown('a.md'), openFile: async (f, o) => opened.push([f, o]) };
  const files = { 'a.md': { path: 'a.md' }, dir: { children: [] } };
  return {
    opened,
    leaf,
    basePath: '/vault',
    abs: (p) => `/vault/${p}`,
    snapshot: () => null,
    latest: null,
    currentView: () => null,
    app: {
      vault: { getAbstractFileByPath: (p) => files[p] || null },
      workspace: {
        getLeaf: (kind) => { leaf.kind = kind; return leaf; },
        iterateAllLeaves: (f) => { f({ view: leaf.view }); f({ view: { file: null } }); },
      },
    },
    ...overrides,
  };
}

test('every tool has a schema and a run function', () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.run, 'function', t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
});

test('selection tools report a snapshot or its absence', () => {
  assert.equal(tool('getCurrentSelection').run(context()).success, false);
  const snap = { text: 'x' };
  assert.deepEqual(tool('getCurrentSelection').run(context({ snapshot: () => snap })), { success: true, text: 'x' });
  assert.equal(tool('getLatestSelection').run(context()).success, false);
  assert.deepEqual(tool('getLatestSelection').run(context({ latest: snap })), { success: true, text: 'x' });
});

test('getOpenEditors lists file views and marks the active one', () => {
  const ctx = context();
  ctx.currentView = () => ctx.leaf.view;
  const { tabs } = tool('getOpenEditors').run(ctx);
  assert.deepEqual(tabs, [{ uri: 'file:///vault/a.md', isActive: true, label: 'a.md', languageId: 'markdown', isDirty: false }]);
});

test('getOpenEditors names other languages by extension', () => {
  const ctx = context();
  ctx.leaf.view = { file: { path: 'a.pdf', name: 'a.pdf', extension: 'pdf' }, getViewType: () => 'pdf' };
  assert.equal(tool('getOpenEditors').run(ctx).tabs[0].languageId, 'pdf');
  ctx.leaf.view.file.extension = '';
  assert.equal(tool('getOpenEditors').run(ctx).tabs[0].languageId, 'plaintext');
});

test('getWorkspaceFolders describes the vault', () => {
  const result = tool('getWorkspaceFolders').run(context());
  assert.equal(result.rootPath, '/vault');
  assert.equal(result.folders[0].name, 'vault');
});

test('stub tools answer as the protocol expects', () => {
  assert.deepEqual(tool('getDiagnostics').run(), []);
  assert.equal(tool('checkDocumentDirty').run(null, { filePath: 'a' }).isDirty, false);
  assert.equal(tool('saveDocument').run(null, { filePath: 'a' }).saved, true);
  assert.equal(tool('closeAllDiffTabs').run(), 'CLOSED_0_DIFF_TABS');
  assert.equal(tool('close_tab').run(), 'TAB_CLOSED');
});

const openFile = (ctx, args) => tool('openFile').run(ctx, args);

test('openFile refuses bad paths', async () => {
  await assert.rejects(openFile(context(), {}), /filePath is required/);
  await assert.rejects(openFile(context(), { filePath: '/etc/passwd' }), /outside the vault/);
  await assert.rejects(openFile(context(), { filePath: 'missing.md' }), /not found/);
  await assert.rejects(openFile(context(), { filePath: 'dir' }), /not found/);
});

test('openFile opens absolute and relative paths in a new tab by default', async () => {
  const ctx = context();
  assert.equal(await openFile(ctx, { filePath: '/vault/a.md' }), 'Opened file: /vault/a.md');
  assert.equal(ctx.leaf.kind, 'tab');
  assert.equal(ctx.opened[0][1].active, true);
  await openFile(ctx, { filePath: 'a.md', preview: true, makeFrontmost: false });
  assert.equal(ctx.leaf.kind, false);
  assert.equal(ctx.opened[1][1].active, false);
});

test('openFile selects from the start text to the end text', async () => {
  const ctx = context();
  ctx.leaf.view.editor = editor('one two three');
  await openFile(ctx, { filePath: 'a.md', startText: 'two', endText: 'three' });
  assert.deepEqual(ctx.leaf.view.editor.calls.selection, [4, 13]);
  assert.equal(ctx.leaf.view.editor.calls.scrolled, true);
});

test('openFile selects the start text alone, and to the end of the line', async () => {
  const ctx = context();
  ctx.leaf.view.editor = editor('one two three');
  await openFile(ctx, { filePath: 'a.md', startText: 'two', endText: 'missing' });
  assert.deepEqual(ctx.leaf.view.editor.calls.selection, [4, 7]);
  await openFile(ctx, { filePath: 'a.md', startText: 'two', selectToEndOfLine: true });
  assert.deepEqual(ctx.leaf.view.editor.calls.selection, [4, 13]);
});

test('openFile leaves the selection alone when the text is absent or the view has no editor', async () => {
  const ctx = context();
  ctx.leaf.view.editor = editor('one');
  await openFile(ctx, { filePath: 'a.md', startText: 'zzz' });
  assert.equal(ctx.leaf.view.editor.calls.selection, undefined);
  ctx.leaf.view = { getViewType: () => 'pdf' };
  await openFile(ctx, { filePath: 'a.md', startText: 'one' });
});
