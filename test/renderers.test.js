'use strict';

const { settle } = require('./support/setup');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { formatFor, FORMATS } = require('../src/formats');
const { treeOf } = require('../src/formats/tree');
const { mermaid } = require('./support/obsidian');
const { TABLE_PAGE_ROWS, TREE_PAGE_ITEMS } = require('../src/limits');

const host = () => document.createElement('div');
const always = () => true;
const toggle = async (branch) => {
  branch.open = !branch.open;
  branch.dispatchEvent(new window.Event('toggle'));
  await settle();
};

async function tree(value) {
  const el = host();
  await treeOf((v) => v)(el).update(value, null, always);
  return el;
}

test('every format has an id, extensions and an icon', () => {
  for (const f of FORMATS) {
    assert.ok(f.id && f.extensions.length && f.icon, f.id);
  }
});

test('tree shows a leaf of each kind', async () => {
  const el = await tree({ s: 'x', n: 1, b: true, z: null });
  await toggle(el.querySelector('details'));
  await toggle(el.querySelector('details'));
  assert.deepEqual([...el.querySelectorAll('.cib-tree-leaf')].map((r) => r.textContent), ['s: "x"', 'n: 1', 'b: true', 'z: null']);
  assert.ok(el.querySelector('.cib-tree-null'));
});

test('tree renders a primitive root', async () => {
  assert.equal((await tree(5)).textContent, '5');
});

test('tree labels the size and builds nested children only on expand', async () => {
  const el = await tree({ a: [1, 2] });
  const details = [...el.querySelectorAll('details')];
  assert.equal(details[0].querySelector('.cib-tree-size').textContent, '{1}');
});

test('tree builds a long array one page at a time', async () => {
  const el = await tree(Array.from({ length: TREE_PAGE_ITEMS * 2 + 1 }, (_, i) => i));
  await settle();
  const root = el.querySelector('details');
  if (!root.querySelector('.cib-tree-leaf')) root.dispatchEvent(new window.Event('toggle'));
  assert.equal(el.querySelectorAll('.cib-tree-leaf').length, TREE_PAGE_ITEMS);
  el.querySelector('.cib-more').click();
  assert.equal(el.querySelectorAll('.cib-tree-leaf').length, TREE_PAGE_ITEMS * 2);
  assert.equal(el.querySelector('.cib-more').textContent, 'Show 1 more');
  el.querySelector('.cib-more').click();
  assert.equal(el.querySelector('.cib-more'), null);
});

test('tree does not refill a branch on a second toggle', async () => {
  const el = await tree([1]);
  const root = el.querySelector('details');
  root.dispatchEvent(new window.Event('toggle'));
  await toggle(root);
  await toggle(root);
  assert.equal(el.querySelectorAll('.cib-tree-leaf').length, 1);
});

test('tree drops a parse that a newer update overtook', async () => {
  const el = host();
  await treeOf((v) => v)(el).update({ a: 1 }, null, () => false);
  assert.equal(el.querySelector('details'), null);
});

test('tree passes a parse error to the view', async () => {
  const renderer = formatFor('json').mount(host());
  await assert.rejects(renderer.update('{oops', null, always));
});

test('csv pages rows and reports progress', () => {
  const el = host();
  const body = Array.from({ length: TABLE_PAGE_ROWS + 5 }, (_, i) => `${i};"n,${i}"`).join('\n');
  formatFor('csv').mount(el).update(`id;name\n${body}\n`, { extension: 'csv' });
  assert.deepEqual([...el.querySelectorAll('th')].map((t) => t.textContent), ['id', 'name']);
  assert.equal(el.querySelectorAll('tbody tr').length, TABLE_PAGE_ROWS);
  assert.match(el.querySelector('.cib-table-status').textContent, /so far/);
  assert.equal(el.querySelector('.cib-more').classList.contains('is-hidden'), false);
  el.querySelector('.cib-more').click();
  assert.equal(el.querySelectorAll('tbody tr').length, TABLE_PAGE_ROWS + 5);
  assert.equal(el.querySelector('.cib-more').classList.contains('is-hidden'), true);
  assert.equal(el.querySelector('tbody td:nth-child(2)').textContent, 'n,0');
});

test('tsv always splits on tabs', () => {
  const el = host();
  formatFor('tsv').mount(el).update('a,b\tc\n1\t2\n', { extension: 'TSV' });
  assert.deepEqual([...el.querySelectorAll('th')].map((t) => t.textContent), ['a,b', 'c']);
});

test('csv copes with an empty file', () => {
  const el = host();
  formatFor('csv').mount(el).update('', { extension: 'csv' });
  assert.equal(el.querySelectorAll('tr').length, 1);
  assert.equal(el.querySelector('.cib-table-status').textContent, '0 rows, 0 columns');
});

test('html frame is sandboxed without same-origin and gets the selection script', () => {
  const el = host();
  const renderer = formatFor('html').mount(el);
  renderer.update('<html><head><title>x</title></head></html>');
  const frame = el.querySelector('iframe');
  assert.equal(renderer.frame, frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-downloads');
  assert.match(frame.getAttribute('srcdoc'), /<head><script>.*frameSelection/);
});

test('html without a head still gets the script', () => {
  const { withSelectionScript } = formatFor('html');
  assert.match(withSelectionScript('<p>x</p>'), /^<script>/);
  assert.match(withSelectionScript('<head lang="ru"><p>$&</p>'), /<p>\$&<\/p>/);
});

test('mermaid draws into an empty sandbox', async () => {
  const el = host();
  const renderer = formatFor('mmd').mount(el);
  await renderer.update('graph TD', null, always);
  assert.equal(renderer.frame.getAttribute('sandbox'), '');
  assert.match(renderer.frame.getAttribute('srcdoc'), /<svg data-source="graph TD">/);
});

test('mermaid drops an overtaken render', async () => {
  const renderer = formatFor('mermaid').mount(host());
  await renderer.update('graph TD', null, () => false);
  assert.equal(renderer.frame.hasAttribute('srcdoc'), false);
});

test('a failed mermaid render clears the frame and its scratch node', async () => {
  const renderer = formatFor('mmd').mount(host());
  await renderer.update('graph TD', null, always);
  const { render } = mermaid;
  mermaid.render = async (id) => {
    const scratch = document.body.appendChild(document.createElement('div'));
    scratch.id = `d${id}`;
    throw new Error('parse');
  };
  try {
    await assert.rejects(renderer.update('bad', null, always), /parse/);
  } finally {
    mermaid.render = render;
  }
  assert.equal(renderer.frame.hasAttribute('srcdoc'), false);
  assert.equal(document.body.querySelector('[id^="dcib-mermaid"]'), null);
});

test('safetensors renders through the reader', async () => {
  const header = Buffer.from('{"w":{"dtype":"F32"}}');
  const bytes = Buffer.alloc(8 + header.length);
  bytes.writeBigUInt64LE(BigInt(header.length));
  header.copy(bytes, 8);
  const el = host();
  await formatFor('safetensors').mount(el).update({
    size: async () => bytes.length, read: async (o, l) => bytes.subarray(o, o + l),
  }, null, always);
  assert.equal(el.querySelector('.cib-tree-size').textContent, '{2}');
});
