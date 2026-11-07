'use strict';

// Two Obsidian views host every format: one for files edited as text, one for
// binary files. What a file looks like is decided by its format record alone.

const { FileView, TextFileView, debounce } = require('obsidian');
const { formatFor } = require('./formats');
const { createReader } = require('./file-reader');
const { lineAt } = require('./selection');
const { TEXT_VIEW, BINARY_VIEW } = require('./view-types');
const { MAX_TEXT_BYTES, OVERSIZE_HEAD_BYTES, PREVIEW_LIMIT_CHARS } = require('./limits');

const REFRESH_DELAY_MS = 800;
const MODES = [['source', 'Editor'], ['preview', 'Viewer'], ['both', 'Both']];
const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));

const viewTypeOf = (format) => (format.binary ? BINARY_VIEW : TEXT_VIEW);

const hostsFormat = (Base) => class extends Base {
  buildPanes(plugin) {
    this.plugin = plugin;
    this.format = null;
    this.renderer = null;
    this.shown = null;
    this.renderRun = 0;
    this.contentEl.addClass('cib-view');
  }

  getDisplayText() { return this.file ? this.file.name : 'File'; }

  getIcon() { return this.format ? this.format.icon : 'file'; }

  canAcceptExtension(extension) {
    const format = formatFor(extension);
    return !!format && viewTypeOf(format) === this.getViewType();
  }

  useFormat(file) {
    const format = formatFor(file.extension);
    if (format === this.format) return;
    this.dropRenderer();
    this.format = format;
    if (format && format.mount) {
      this.renderer = format.mount(this.preview);
      this.errorEl = this.preview.createDiv('cib-error');
    }
  }

  dropRenderer() {
    this.renderRun += 1;
    this.renderer = null;
    this.format = null;
    this.shown = null;
    this.preview.replaceChildren();
  }

  // A format throws what it cannot show, and an update that a newer one
  // overtook is dropped: `isCurrent` tells a slow format to stop.
  async render(content) {
    this.renderRun += 1;
    const run = this.renderRun;
    const isCurrent = () => run === this.renderRun;
    const { renderer } = this;
    let message = '';
    try {
      await renderer.update(content, this.file, isCurrent);
    } catch (e) {
      message = e.message;
    }
    if (isCurrent()) this.errorEl.textContent = message;
  }
};

class TextFormatView extends hostsFormat(TextFileView) {
  constructor(leaf, plugin) {
    super(leaf);
    this.buildPanes(plugin);
    this.oversize = false;
    this.editorText = '';
    this.toolbar = this.contentEl.createDiv('cib-toolbar');
    this.modeButtons = MODES.map(([mode, label]) => {
      const button = this.toolbar.createEl('button', { text: label });
      button.addEventListener('click', () => this.setMode(mode));
      return { mode, button };
    });
    this.notice = this.contentEl.createDiv('cib-notice');
    this.panes = this.contentEl.createDiv('cib-panes');
    this.editor = this.panes.createEl('textarea', { cls: 'cib-editor', attr: { spellcheck: 'false' } });
    this.preview = this.panes.createDiv('cib-preview');
    this.refreshLater = debounce(() => this.refresh(), REFRESH_DELAY_MS, true);
    this.editor.addEventListener('input', () => {
      this.editorText = this.editor.value;
      this.data = this.editorText;
      this.requestSave();
      this.refreshLater();
    });
    for (const event of ['select', 'keyup', 'mouseup']) {
      this.editor.addEventListener(event, () => this.reportEditorSelection());
    }
    this.applyMode();
  }

  getViewType() { return TEXT_VIEW; }

  get mode() {
    if (!this.renderer) return 'source';
    return this.plugin.settings.modes[this.format.id] || 'preview';
  }

  // Too big to hold in memory: show the head, read-only, and keep Obsidian's
  // save and reload paths away so the file on disk is never touched.
  async onLoadFile(file) {
    if (file.stat.size <= MAX_TEXT_BYTES) {
      await super.onLoadFile(file);
      return;
    }
    this.oversize = true;
    const head = await createReader(this.plugin.abs(file.path)).read(0, OVERSIZE_HEAD_BYTES);
    this.dropRenderer();
    this.data = new TextDecoder().decode(head);
    this.editor.readOnly = true;
    this.notice.textContent = `This file is ${megabytes(file.stat.size)} MB. Showing the first ${OVERSIZE_HEAD_BYTES / 1024} KB, read-only.`;
    this.applyMode();
    this.syncEditor();
  }

  async onUnloadFile(file) {
    await super.onUnloadFile(file);
    if (!this.oversize) return;
    this.oversize = false;
    this.editor.readOnly = false;
    this.notice.textContent = '';
    this.clear();
  }

  onModify(file) {
    if (!this.oversize) super.onModify(file);
  }

  async save(clear) {
    if (!this.oversize) await super.save(clear);
  }

  getViewData() { return this.data; }

  setViewData(data) {
    this.data = data;
    this.useFormat(this.file);
    this.applyMode();
    this.syncEditor();
    this.refresh();
  }

  clear() {
    this.refreshLater.cancel();
    this.data = '';
    this.editorText = '';
    this.editor.value = '';
    this.forgetSelection();
    this.dropRenderer();
  }

  async onClose() {
    this.refreshLater.cancel();
    this.forgetSelection();
    this.dropRenderer();
  }

  forgetSelection() {
    if (this.file) this.plugin.setSelection(this.file.path, '');
  }

  setMode(mode) {
    this.plugin.settings.modes[this.format.id] = mode;
    this.plugin.saveData(this.plugin.settings);
    this.applyMode();
    this.syncEditor();
    this.refresh();
  }

  applyMode() {
    this.toolbar.toggleClass('is-hidden', !this.renderer);
    this.panes.dataset.mode = this.mode;
    for (const { mode, button } of this.modeButtons) button.toggleClass('is-active', mode === this.mode);
  }

  // The textarea keeps its own copy of the text, so it is filled only when seen.
  syncEditor() {
    if (this.mode === 'preview' || this.editorText === this.data) return;
    this.editorText = this.data;
    this.editor.value = this.data;
  }

  // Rendering can be costly (an HTML page restarts), so do it only when the
  // text changed, and not at all while the preview is hidden.
  refresh() {
    if (!this.renderer || this.mode === 'source' || this.data === this.shown) return;
    this.shown = this.data;
    const limit = this.format.previewLimit || PREVIEW_LIMIT_CHARS;
    if (this.data.length > limit) {
      this.errorEl.textContent = `Too large to preview (limit ${megabytes(limit)} MB). Use the Editor.`;
      return;
    }
    this.render(this.data);
  }

  reportEditorSelection() {
    if (!this.file) return;
    const { selectionStart: from, selectionEnd: to, value } = this.editor;
    this.plugin.setSelection(this.file.path, value.slice(from, to), lineAt(value, from), lineAt(value, to));
    this.plugin.schedulePush();
  }
}

class BinaryFormatView extends hostsFormat(FileView) {
  constructor(leaf, plugin) {
    super(leaf);
    this.buildPanes(plugin);
    this.panes = this.contentEl.createDiv('cib-panes');
    this.panes.dataset.mode = 'preview';
    this.preview = this.panes.createDiv('cib-preview');
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file === this.file) this.show();
    }));
  }

  getViewType() { return BINARY_VIEW; }

  async onLoadFile(file) {
    await super.onLoadFile(file);
    this.show();
  }

  async onUnloadFile(file) {
    this.dropRenderer();
    await super.onUnloadFile(file);
  }

  // Formats get a reader, not the bytes: model files run to many gigabytes.
  show() {
    this.useFormat(this.file);
    if (this.renderer) this.render(createReader(this.plugin.abs(this.file.path)));
  }
}

module.exports = { TextFormatView, BinaryFormatView, viewTypeOf };
