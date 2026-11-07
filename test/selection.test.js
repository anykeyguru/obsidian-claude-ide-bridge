'use strict';

require('./support/setup');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  isDomView, isFileView, shadowSelection, lineAt, pageOf, selectionPayload, sameSelection,
} = require('../src/selection');
const { TEXT_VIEW, BINARY_VIEW } = require('../src/view-types');

const view = (type, file = {}) => ({ file, getViewType: () => type });

test('classifies views by type', () => {
  for (const type of [TEXT_VIEW, BINARY_VIEW, 'pdf']) assert.ok(isDomView(view(type)));
  assert.equal(isDomView(view('markdown')), false);
  assert.ok(isFileView(view('markdown')));
  assert.ok(isFileView(view('pdf')));
  assert.equal(isFileView(view('graph')), false);
});

test('a view without a file is not a file view', () => {
  assert.equal(isFileView(view('markdown', null)), false);
  assert.equal(isDomView(null), false);
});

test('lineAt counts line breaks before the offset', () => {
  const text = 'a\nb\n\nc';
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((o) => lineAt(text, o)), [1, 1, 2, 2, 3, 4, 4]);
  assert.equal(lineAt('', 0), 1);
});

test('pageOf finds the enclosing page', () => {
  const page = document.createElement('div');
  page.setAttribute('data-page-number', '7');
  const text = page.appendChild(document.createElement('span')).appendChild(document.createTextNode('x'));
  assert.equal(pageOf(text), 7);
  assert.equal(pageOf(page), 7);
  assert.equal(pageOf(document.createElement('p')), 1);
  assert.equal(pageOf(null), 1);
});

test('shadowSelection returns the first non-empty one', () => {
  const root = document.createElement('div');
  const host = root.appendChild(document.createElement('div'));
  const empty = root.appendChild(document.createElement('div'));
  const selection = { toString: () => 'text' };
  Object.defineProperty(empty, 'shadowRoot', { value: { getSelection: () => ({ toString: () => '  ' }) } });
  Object.defineProperty(host, 'shadowRoot', { value: { getSelection: () => selection } });
  assert.equal(shadowSelection(root), selection);
  assert.equal(shadowSelection(document.createElement('div')), null);
});

test('selectionPayload builds a file URL and detects an empty range', () => {
  const a = { line: 1, character: 2 };
  const payload = selectionPayload('/v/a b.md', 't', a, { line: 1, character: 2 });
  assert.equal(payload.fileUrl, 'file:///v/a%20b.md');
  assert.equal(payload.selection.isEmpty, true);
  assert.equal(selectionPayload('/v/a', 't', a, { line: 2, character: 0 }).selection.isEmpty, false);
});

test('sameSelection compares content and range', () => {
  const make = (text, line) => selectionPayload('/f', text, { line, character: 0 }, { line, character: 1 });
  assert.ok(sameSelection(make('a', 1), make('a', 1)));
  assert.equal(sameSelection(make('a', 1), make('b', 1)), false);
  assert.equal(sameSelection(make('a', 1), make('a', 2)), false);
  assert.equal(sameSelection(make('a', 1), null), false);
});
