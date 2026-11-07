'use strict';

const { settle } = require('./support/setup');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { TFile, FileSystemAdapter } = require('./support/obsidian');
const { TextFormatView, BinaryFormatView, viewTypeOf } = require('../src/views');
const { TEXT_VIEW, BINARY_VIEW } = require('../src/view-types');
const { formatFor } = require('../src/formats');
const { MAX_TEXT_BYTES, OVERSIZE_HEAD_BYTES, PREVIEW_LIMIT_CHARS } = require('../src/limits');

function setup(content = '{"a":1}', { size } = {}) {
  const writes = [];
  const reads = [];
  const handlers = [];
  const app = {
    vault: {
      read: async (f) => { reads.push(f.path); return content; },
      modify: async (f, c) => { writes.push(c); },
      on: (name, handler) => { handlers.push(handler); return handler; },
      adapter: new FileSystemAdapter(),
    },
  };
  const selections = [];
  const plugin = {
    settings: { modes: {} },
    saved: 0,
    saveData() { this.saved += 1; },
    abs: (p) => p,
    setSelection: (...args) => selections.push(args),
    schedulePush() { this.pushes = (this.pushes || 0) + 1; },
  };
  const make = (View, file) => {
    const view = new View({ app }, plugin);
    view.file = file;
    return view;
  };
  return {
    app, plugin, writes, reads, selections, handlers, make, file: (name) => new TFile(name, size ?? content.length),
  };
}

async function open(s, name = 'a.json') {
  const file = s.file(name);
  const view = s.make(TextFormatView, file);
  await view.onLoadFile(file);
  await settle();
  return view;
}

const click = (view, label) => view.modeButtons.find((b) => b.button.textContent === label).button.click();

test('view types follow the format', () => {
  assert.equal(viewTypeOf(formatFor('json')), TEXT_VIEW);
  assert.equal(viewTypeOf(formatFor('safetensors')), BINARY_VIEW);
});

test('a text view accepts only text formats', async () => {
  const view = await open(setup());
  assert.ok(view.canAcceptExtension('yaml'));
  assert.equal(view.canAcceptExtension('safetensors'), false);
  assert.equal(view.canAcceptExtension('nope'), false);
  assert.equal(view.getViewType(), TEXT_VIEW);
  assert.equal(view.getDisplayText(), 'a.json');
  assert.equal(view.getIcon(), 'braces');
});

test('a view before any file has defaults', () => {
  const s = setup();
  const view = s.make(TextFormatView, null);
  assert.equal(view.getDisplayText(), 'File');
  assert.equal(view.getIcon(), 'file');
  view.reportEditorSelection();
  assert.deepEqual(s.selections, []);
});

test('preview is the default mode and the hidden editor stays empty', async () => {
  const view = await open(setup());
  assert.equal(view.panes.dataset.mode, 'preview');
  assert.equal(view.editor.value, '');
  assert.ok(view.preview.querySelector('details'));
});

test('switching to the editor fills it and remembers the mode', async () => {
  const s = setup();
  const view = await open(s);
  click(view, 'Editor');
  assert.equal(view.editor.value, '{"a":1}');
  assert.equal(view.panes.dataset.mode, 'source');
  assert.equal(s.plugin.settings.modes.json, 'source');
  assert.equal(s.plugin.saved, 1);
  assert.ok(view.modeButtons[0].button.classList.contains('is-active'));
});

test('a format without a viewer opens as a plain editor', async () => {
  const view = await open(setup('text'), 'a.txt');
  assert.equal(view.panes.dataset.mode, 'source');
  assert.ok(view.toolbar.classList.contains('is-hidden'));
  assert.equal(view.editor.value, 'text');
});

test('typing saves and refreshes the preview after a pause', async () => {
  const s = setup();
  const view = await open(s);
  click(view, 'Both');
  view.editor.value = '{"b":2}';
  view.editor.dispatchEvent(new window.Event('input'));
  assert.equal(view.getViewData(), '{"b":2}');
  assert.equal(view.dirty, true);
  assert.ok(view.refreshLater.calls > 0);
  view.refreshLater.flush();
  await settle();
  assert.equal(view.shown, '{"b":2}');
});

test('the preview does not render unchanged text twice', async () => {
  const view = await open(setup());
  const before = view.renderRun;
  view.refresh();
  assert.equal(view.renderRun, before);
});

test('a hidden preview is not rendered', async () => {
  const view = await open(setup());
  click(view, 'Editor');
  view.data = '{"c":3}';
  const before = view.renderRun;
  view.refresh();
  assert.equal(view.renderRun, before);
});

test('a parse error shows in the preview and clears after a fix', async () => {
  const view = await open(setup('{oops'));
  assert.match(view.errorEl.textContent, /JSON/);
  view.setViewData('{}');
  await settle();
  assert.equal(view.errorEl.textContent, '');
});

test('an overtaken render does not show its error', async () => {
  const view = await open(setup());
  const slow = view.render('{oops');
  view.renderRun += 1;
  await slow;
  assert.equal(view.errorEl.textContent, '');
});

test('text over the preview limit stays in the editor', async () => {
  const view = await open(setup('{}'));
  view.data = ' '.repeat(PREVIEW_LIMIT_CHARS + 1);
  view.refresh();
  assert.match(view.errorEl.textContent, /Too large to preview/);
});

test('a format may lower the preview limit', async () => {
  const view = await open(setup('a: 1'), 'a.yaml');
  view.data = ' '.repeat(formatFor('yaml').previewLimit + 1);
  view.refresh();
  assert.match(view.errorEl.textContent, /limit 4 MB/);
});

test('reopening with another format remounts the viewer', async () => {
  const s = setup('a: 1');
  const view = await open(s, 'a.yaml');
  view.file = s.file('b.html');
  view.setViewData('<p>x</p>');
  assert.equal(view.format.id, 'html');
  assert.ok(view.preview.querySelector('iframe'));
  assert.equal(view.preview.querySelector('.cib-tree'), null);
});

test('editor selection reports text and 1-based lines', async () => {
  const s = setup('one\ntwo\nthree', {});
  const view = await open(s, 'a.txt');
  view.editor.setSelectionRange(4, 9);
  view.editor.dispatchEvent(new window.Event('select'));
  assert.deepEqual(s.selections.at(-1), ['a.txt', 'two\nt', 2, 3]);
  assert.equal(s.plugin.pushes, 1);
});

test('closing forgets the selection and the timer', async () => {
  const s = setup();
  const view = await open(s);
  await view.onClose();
  assert.deepEqual(s.selections.at(-1), ['a.json', '']);
  assert.equal(view.renderer, null);
});

test('clear empties the view', async () => {
  const view = await open(setup());
  view.clear();
  assert.deepEqual([view.data, view.editor.value, view.format], ['', '', null]);
  assert.equal(view.preview.children.length, 0);
});

test('saving a normal file goes through to the vault', async () => {
  const s = setup();
  const view = await open(s);
  view.data = 'changed';
  await view.save(false);
  assert.deepEqual(s.writes, ['changed']);
});

function oversize(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cib-big-'));
  const name = path.join(dir, 'huge.log');
  fs.writeFileSync(name, content);
  return name;
}

test('a file over the limit is never read whole and shows its head read-only', async () => {
  const name = oversize('x'.repeat(OVERSIZE_HEAD_BYTES + 100));
  const s = setup('', { size: MAX_TEXT_BYTES + 1 });
  const file = s.file(name);
  const view = s.make(TextFormatView, file);
  await view.onLoadFile(file);
  assert.deepEqual(s.reads, []);
  assert.equal(view.editor.value.length, OVERSIZE_HEAD_BYTES);
  assert.equal(view.editor.readOnly, true);
  assert.match(view.notice.textContent, /32 MB.*read-only/);
  assert.equal(view.panes.dataset.mode, 'source');
  assert.ok(view.toolbar.classList.contains('is-hidden'));
});

test('a file over the limit is never written back, on save or on close', async () => {
  const name = oversize('head');
  const s = setup('', { size: MAX_TEXT_BYTES + 1 });
  const file = s.file(name);
  const view = s.make(TextFormatView, file);
  await view.onLoadFile(file);
  view.lastSavedData = 'stale buffer from a previous file';
  await view.save(false);
  await view.onUnloadFile(file);
  assert.deepEqual(s.writes, []);
  assert.equal(view.oversize, false);
  assert.equal(view.editor.readOnly, false);
  assert.equal(view.notice.textContent, '');
});

test('a change on disk does not reload a file over the limit', async () => {
  const name = oversize('head');
  const s = setup('', { size: MAX_TEXT_BYTES + 1 });
  const file = s.file(name);
  const view = s.make(TextFormatView, file);
  await view.onLoadFile(file);
  view.onModify(file);
  await settle();
  assert.deepEqual(s.reads, []);
});

test('a change on disk reloads a normal file', async () => {
  const s = setup();
  const view = await open(s);
  await view.onModify(view.file);
  assert.equal(s.reads.length, 2);
});

test('a file exactly at the limit still loads', async () => {
  const s = setup('{}', { size: MAX_TEXT_BYTES });
  const view = await open(s);
  assert.equal(view.oversize, false);
  assert.equal(s.reads.length, 1);
});

test('a binary view reads through a reader and redraws on change', async () => {
  const header = Buffer.from('{}');
  const bytes = Buffer.alloc(10);
  bytes.writeBigUInt64LE(BigInt(header.length));
  header.copy(bytes, 8);
  const name = oversize(bytes);
  const s = setup();
  const file = new TFile(name.replace(/log$/, 'safetensors'));
  fs.renameSync(name, file.path);
  const view = s.make(BinaryFormatView, file);
  assert.equal(view.getViewType(), BINARY_VIEW);
  await view.onLoadFile(file);
  await new Promise((r) => { setTimeout(r, 30); });
  assert.ok(view.preview.querySelector('details'));
  const run = view.renderRun;
  s.handlers[0](file);
  s.handlers[0](new TFile('other.safetensors'));
  assert.equal(view.renderRun, run + 1);
  await view.onUnloadFile(file);
  assert.equal(view.renderer, null);
});

test('a binary view shows a broken file as an error', async () => {
  const name = oversize('xx');
  const s = setup();
  const file = new TFile(name.replace(/log$/, 'safetensors'));
  fs.renameSync(name, file.path);
  const view = s.make(BinaryFormatView, file);
  await view.onLoadFile(file);
  await new Promise((r) => { setTimeout(r, 30); });
  assert.match(view.errorEl.textContent, /too short/);
});
