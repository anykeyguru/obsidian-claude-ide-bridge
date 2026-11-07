'use strict';

require('./support/setup');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { FORMATS, formatFor } = require('../src/formats');
const { createReader } = require('../src/file-reader');
const { readHeader } = require('../src/formats/safetensors');
const { parseYaml } = require('../src/formats/yaml');
const { installKit } = require('../src/kit/install');
const { parseToml } = require('../src/formats/toml');
const { parseJsonLines } = require('../src/formats/jsonl');
const { parseDelimited, detectSeparator } = require('../src/formats/csv');

const memoryReader = (bytes) => ({
  size: async () => bytes.length,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
});

function safetensors(header) {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([prefix, json, Buffer.alloc(16)]);
}

test('each extension belongs to one format', () => {
  const all = FORMATS.flatMap((f) => f.extensions);
  assert.equal(new Set(all).size, all.length);
});

test('extension lookup ignores case and rejects unknown types', () => {
  assert.equal(formatFor('YAML').id, 'yaml');
  assert.equal(formatFor('nope'), null);
});

test('safetensors header separates metadata from tensors', async () => {
  const tensor = { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] };
  const file = safetensors({ __metadata__: { format: 'pt' }, weight: tensor });
  assert.deepEqual(await readHeader(memoryReader(file)), {
    metadata: { format: 'pt' }, tensors: { weight: tensor },
  });
});

test('safetensors rejects a header longer than the file', async () => {
  const bad = Buffer.alloc(16);
  bad.writeBigUInt64LE(1000n);
  await assert.rejects(readHeader(memoryReader(bad)), /bad header length/);
});

test('safetensors rejects a truncated file', async () => {
  await assert.rejects(readHeader(memoryReader(Buffer.alloc(3))), /too short/);
});

test('yaml reads one document as a value and several as a list', () => {
  assert.deepEqual(parseYaml('a: 1'), { a: 1 });
  assert.deepEqual(parseYaml('a: 1\n---\nb: 2\n'), [{ a: 1 }, { b: 2 }]);
});

test('yaml reports invalid input', () => {
  assert.throws(() => parseYaml('a: [1'));
});

test('file reader returns the requested range and stops at the end', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cib-')), 'x.bin');
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  const reader = createReader(file);
  assert.equal(await reader.size(), 4);
  assert.deepEqual([...await reader.read(1, 2)], [2, 3]);
  assert.deepEqual([...await reader.read(3, 10)], [4]);
});

test('toml nests tables and turns dates into text', () => {
  const parsed = parseToml('[a]\nb = 1\nd = 2026-11-07T00:00:00Z\nl = [2026-11-07T00:00:00Z]');
  assert.equal(JSON.stringify(parsed), '{"a":{"b":1,"d":"2026-11-07T00:00:00.000Z","l":["2026-11-07T00:00:00.000Z"]}}');
});

test('toml reports invalid input', () => {
  assert.throws(() => parseToml('a ='));
});

test('jsonl skips blank lines and names the broken line', () => {
  assert.deepEqual(parseJsonLines('{"a":1}\n\n2\n'), [{ a: 1 }, 2]);
  assert.throws(() => parseJsonLines('1\n{oops'), /^Error: Line 2/);
});

test('csv handles quotes, doubled quotes and line breaks in fields', () => {
  assert.deepEqual(parseDelimited('a,"b,c"\n"d""e","f\ng"\n', ',').rows, [['a', 'b,c'], ['d"e', 'f\ng']]);
});

test('csv handles CRLF, a BOM, blank lines and empty fields', () => {
  assert.deepEqual(parseDelimited('﻿a,b\r\n\r\n,\r\nc,\r\n', ',').rows, [['a', 'b'], ['', ''], ['c', '']]);
});

test('csv keeps a last row without a line break and an unclosed quote', () => {
  assert.deepEqual(parseDelimited('a\nb', ',').rows, [['a'], ['b']]);
  assert.deepEqual(parseDelimited('"a,b', ',').rows, [['a,b']]);
  assert.deepEqual(parseDelimited('', ',').rows, []);
});

test('separator comes from the first line and ignores quoted text', () => {
  assert.equal(detectSeparator('a;b;c\n1,2,3,4,5,6'), ';');
  assert.equal(detectSeparator('"a,b,c";d'), ';');
  assert.equal(detectSeparator('a\tb'), '\t');
  assert.equal(detectSeparator('one'), ',');
});

const kitRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cib-kit-'));
const readKit = (root) => fs.readFileSync(path.join(root, 'a/b.md'), 'utf8');
const kitFile = (content) => [{ path: 'a/b.md', content }];

test('kit writes a missing file and records it', async () => {
  const root = kitRoot();
  const installed = await installKit(root, kitFile('v1'), {});
  assert.equal(readKit(root), 'v1');
  assert.ok(installed['a/b.md']);
});

test('kit updates its own copy', async () => {
  const root = kitRoot();
  const installed = await installKit(root, kitFile('v1'), {});
  await installKit(root, kitFile('v2'), installed);
  assert.equal(readKit(root), 'v2');
});

test('kit keeps a file the user changed', async () => {
  const root = kitRoot();
  const installed = await installKit(root, kitFile('v1'), {});
  fs.writeFileSync(path.join(root, 'a/b.md'), 'mine');
  await installKit(root, kitFile('v2'), installed);
  assert.equal(readKit(root), 'mine');
});

test('kit does not overwrite a file it never wrote', async () => {
  const root = kitRoot();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a/b.md'), 'mine');
  await installKit(root, kitFile('v1'), {});
  assert.equal(readKit(root), 'mine');
});

test('kit does not bring back a file the user deleted', async () => {
  const root = kitRoot();
  const installed = await installKit(root, kitFile('v1'), {});
  fs.rmSync(path.join(root, 'a/b.md'));
  await installKit(root, kitFile('v2'), installed);
  assert.equal(fs.existsSync(path.join(root, 'a/b.md')), false);
});

test('csv stops at the row limit and resumes from next', () => {
  const first = parseDelimited('a\nb\nc\n', ',', 0, 2);
  assert.deepEqual(first.rows, [['a'], ['b']]);
  const rest = parseDelimited('a\nb\nc\n', ',', first.next, 2);
  assert.deepEqual(rest.rows, [['c']]);
  assert.equal(rest.next, -1);
});

test('csv does not read past the requested rows of a large text', () => {
  const text = `${'x,y\n'.repeat(5000)}"unclosed`;
  const { rows, next } = parseDelimited(text, ',', 0, 10);
  assert.equal(rows.length, 10);
  assert.equal(next, 40);
});

test('kit records a file that already has its content', async () => {
  const root = kitRoot();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a/b.md'), 'v1');
  const installed = await installKit(root, kitFile('v1'), {});
  assert.ok(installed['a/b.md']);
});

test('kit reports a real read failure', async () => {
  const root = kitRoot();
  fs.mkdirSync(path.join(root, 'a/b.md'), { recursive: true });
  await assert.rejects(installKit(root, kitFile('v1'), {}), /EISDIR/);
});
