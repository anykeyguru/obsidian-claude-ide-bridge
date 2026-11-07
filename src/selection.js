'use strict';

const { pathToFileURL } = require('url');
const { TEXT_VIEW, BINARY_VIEW } = require('./view-types');

const typeOf = (v) => (v && v.file && v.getViewType ? v.getViewType() : '');

// Views without a Markdown editor, whose selection is tracked separately.
const isDomView = (v) => [TEXT_VIEW, BINARY_VIEW, 'pdf'].includes(typeOf(v));
const isFileView = (v) => typeOf(v) === 'markdown' || isDomView(v);

// Chromium reports a selection inside a shadow root as collapsed on the host,
// so ask the shadow roots mounted in the view.
// Only the view's light DOM is scanned: a PDF text layer has thousands of nodes.
function shadowSelection(rootEl) {
  for (const host of rootEl.querySelectorAll('*')) {
    const root = host.shadowRoot;
    const sel = root && typeof root.getSelection === 'function' ? root.getSelection() : null;
    if (sel && sel.toString().trim()) return sel;
  }
  return null;
}

// 1-based line of `offset`, without copying the text.
function lineAt(text, offset) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

function pageOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const page = el && el.closest('[data-page-number]');
  return page ? Number(page.getAttribute('data-page-number')) : 1;
}

function selectionPayload(filePath, text, start, end) {
  return {
    text,
    filePath,
    fileUrl: pathToFileURL(filePath).href,
    selection: { start, end, isEmpty: start.line === end.line && start.character === end.character },
  };
}

function sameSelection(a, b) {
  if (!a || !b) return false;
  const [s, t] = [a.selection, b.selection];
  return a.filePath === b.filePath && a.text === b.text
    && s.start.line === t.start.line && s.start.character === t.start.character
    && s.end.line === t.end.line && s.end.character === t.end.character;
}

module.exports = {
  isDomView, isFileView, shadowSelection, lineAt, pageOf, selectionPayload, sameSelection,
};
