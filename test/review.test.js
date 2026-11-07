'use strict';

const { settle } = require('./support/setup');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

const { TEMPLATE } = require('../src/kit');
const { buildReviewHtml, parseMeta, isGeneratedPage, SOURCE_EXTENSIONS } = require('../src/review/build');
const { languageOf, LANGUAGES } = require('../src/review/labels');
const { run, parseArgs } = require('../src/review/cli');
const { MAX_REVIEW_SOURCE_BYTES, REVIEW_SAMPLE_ROWS } = require('../src/limits');

const TEMPLATE_DIR = path.join(__dirname, '../src/kit/skills/html-review-doc');
const make = (text, extension, options = {}) => buildReviewHtml({
  template: TEMPLATE, text, extension, name: 'data', ...options,
});

function contractOf(html) {
  const [, json] = html.match(/<script type="application\/json" id="contract">([\s\S]*?)<\/script>/);
  return JSON.parse(json);
}

async function render(html) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false });
      win.fetch = async () => ({ ok: false });
    },
  });
  await new Promise((r) => { setTimeout(r, 20); });
  const { document } = dom.window;
  return { document, keys: () => [...document.querySelectorAll('.key')].map((k) => k.textContent) };
}

test('the same input gives the same bytes', () => {
  for (const [text, extension] of [['{"a":1}', 'json'], ['a: 1', 'yaml'], ['a,b\n1,2', 'csv'], ['CREATE TABLE t (a int);', 'sql']]) {
    assert.equal(make(text, extension), make(text, extension));
  }
});

test('JSON keeps source key order', () => {
  assert.deepEqual(Object.keys(contractOf(make('{"z":1,"a":2}', 'json')).documents.data), ['z', 'a']);
});

test('a page leaves no placeholders and is marked as generated', () => {
  const html = make('{}', 'json', { title: 'T', lang: 'ru' });
  assert.ok(!html.includes('__DOC_NAME__') && !html.includes('__TITLE__'));
  assert.ok(html.includes("const DOC = 'data.review.html'"));
  assert.ok(isGeneratedPage(html));
  assert.equal(isGeneratedPage(TEMPLATE), false);
  assert.match(html, /<html lang="ru">/);
});

test('every source extension builds, and an unknown one is refused', () => {
  const samples = {
    json: '{}', jsonl: '{}', ndjson: '{}', yaml: 'a: 1', yml: 'a: 1', toml: 'a = 1', csv: 'a\n1', tsv: 'a\n1', sql: 'CREATE TABLE t (a int);',
  };
  for (const extension of SOURCE_EXTENSIONS) assert.ok(make(samples[extension], extension), extension);
  assert.ok(make('{}', 'JSON'));
  assert.throws(() => make('x', 'docx'), /Cannot build/);
});

test('a source over the limit is refused', () => {
  assert.throws(() => make(' '.repeat(MAX_REVIEW_SOURCE_BYTES + 1), 'json'), /over 8 MB/);
});

test('invalid data is reported', () => {
  assert.throws(() => make('{oops', 'json'));
  assert.throws(() => make('a: [1', 'yaml'));
});

test('a multi-document YAML gets one tab per document', async () => {
  const page = await render(make('a: 1\n---\nb: 2\n', 'yaml'));
  assert.deepEqual([...page.document.querySelectorAll('[role=tab]')].map((t) => t.textContent), ['data 1', 'data 2']);
  assert.deepEqual(page.keys(), ['"a"', '"b"']);
});

test('CSV and JSONL are sampled, and CSV keeps columns as keys', () => {
  const rows = Array.from({ length: REVIEW_SAMPLE_ROWS * 3 }, (_, i) => `${i};x`).join('\n');
  const csv = contractOf(make(`id;name\n${rows}`, 'csv')).documents.data;
  assert.equal(csv.length, REVIEW_SAMPLE_ROWS);
  assert.deepEqual(csv[0], { id: '0', name: 'x' });
  assert.deepEqual(contractOf(make('a\tb\n1\n', 'tsv')).documents.data[0], { a: '1', b: '' });
  const lines = Array.from({ length: REVIEW_SAMPLE_ROWS * 2 }, (_, i) => `{"n":${i}}`).join('\n');
  assert.equal(contractOf(make(lines, 'jsonl')).documents.data.length, REVIEW_SAMPLE_ROWS);
});

test('SQL fills passports with facts and leaves classes to people', async () => {
  const sql = "CREATE TABLE orders (id bigint PRIMARY KEY, total numeric(10,2) DEFAULT 0, customer bigint REFERENCES customers(id)); COMMENT ON COLUMN orders.total IS 'Сумма';";
  const html = make(sql, 'sql', { lang: 'ru' });
  const contract = contractOf(html);
  assert.deepEqual(contract.fields['orders:total'], {
    type: 'numeric(10, 2)', title: 'Сумма', nullable: 'да', key: '—', default: '0', references: '—',
  });
  assert.equal(contract.fields['orders:id'].key, 'PRIMARY');
  assert.equal(contract.fields['orders:id'].class, undefined);
  const page = await render(html);
  page.document.querySelectorAll('.key')[1].click();
  await settle();
  const card = page.document.querySelector('.detail');
  assert.equal(card.querySelector('h3').textContent, 'total');
  assert.equal(card.querySelector('.biz').textContent, 'Сумма');
  assert.match(card.querySelector('.kv').textContent, /Типnumeric\(10, 2\)/);
  assert.match(card.querySelector('.kv').textContent, /NULLда/);
  assert.match(card.querySelector('.kv').textContent, /По умолчанию0/);
  assert.ok(card.querySelector('select'), 'class is left to choose');
});

test('tables sharing a column name keep separate passports', async () => {
  const sql = "CREATE TABLE a (id int COMMENT 'A id'); CREATE TABLE b (id bigint COMMENT 'B id');";
  const page = await render(make(sql, 'sql'));
  const cards = [...page.document.querySelectorAll('.detail .biz')].map((b) => b.textContent);
  assert.deepEqual(cards, ['A id', 'B id']);
});

test('the fields file adds classes and titles over what the data says', () => {
  const meta = parseMeta('title: Заказы\nlang: ru\nfields:\n  orders:id: { class: static, title: Номер }\n  id: { owner: me }\n  extra: { class: model }\n');
  const html = make('CREATE TABLE orders (id int);', 'sql', { meta });
  const { fields } = contractOf(html);
  assert.deepEqual(fields['orders:id'], {
    type: 'int', nullable: 'да', key: '—', default: '—', references: '—', class: 'static', title: 'Номер', owner: 'me',
  });
  assert.deepEqual(fields.extra, { class: 'model' });
  assert.match(html, /<title>Заказы<\/title>/);
  assert.match(html, /"save": "Сохранить"/);
});

test('the fields file may replace the legend and the attributes', () => {
  const meta = {
    groups: [], classes: [{ id: 'x', label: 'X' }], statuses: [], statusLabel: 'S', attributes: [{ key: 'k', label: 'K' }],
  };
  const contract = contractOf(make('{}', 'json', { meta }));
  assert.deepEqual(contract.classes, [{ id: 'x', label: 'X' }]);
  assert.equal(contract.statusLabel, 'S');
  assert.deepEqual(contract.attributes, [{ key: 'k', label: 'K' }]);
});

test('an empty fields file means no additions', () => {
  assert.deepEqual(parseMeta(''), {});
});

test('text from the data cannot break out of the page', async () => {
  const html = make('{"a":"</script><script>window.pwned=1</script>"}', 'json', { title: '<b>&' });
  assert.ok(!html.includes('</script><script>window.pwned'));
  assert.match(html, /<title>&lt;b&gt;&amp;<\/title>/);
  const page = await render(html);
  assert.equal(page.document.defaultView.pwned, undefined);
  assert.deepEqual(page.keys(), ['"a"']);
});

test('dollar signs in data stay literal', () => {
  assert.ok(make('{"a":"$& $1"}', 'json', { title: 'a$&b' }).includes('a$&amp;b'));
});

test('a broken template is reported', () => {
  assert.throws(() => buildReviewHtml({ template: '<p>', text: '{}', extension: 'json', name: 'x' }), /Template has no/);
});

test('both languages define the same labels', () => {
  assert.deepEqual(Object.keys(LANGUAGES.ru.labels), Object.keys(LANGUAGES.en.labels));
  assert.equal(languageOf('xx'), LANGUAGES.en);
});

test('the English labels match the template', () => {
  for (const value of Object.values(LANGUAGES.en.labels).filter((v) => typeof v === 'string')) {
    assert.ok(TEMPLATE.includes(`'${value}'`), value);
  }
});

function workspace(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cib-review-'));
  fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('CLI options', () => {
  assert.deepEqual(parseArgs(['a.json', '--lang', 'ru', '--title', 'T']), { file: 'a.json', title: 'T', lang: 'ru' });
});

test('CLI writes next to the file and reads the fields file', () => {
  const dir = workspace('data.yaml', 'a: 1\n');
  fs.writeFileSync(path.join(dir, 'data.fields.yaml'), 'fields:\n  a: { title: Hello }\n');
  const output = run([path.join(dir, 'data.yaml'), '--lang', 'ru'], TEMPLATE_DIR);
  assert.equal(output, path.join(dir, 'data.review.html'));
  const html = fs.readFileSync(output, 'utf8');
  assert.equal(contractOf(html).fields.a.title, 'Hello');
  assert.equal(run([path.join(dir, 'data.yaml'), '--lang', 'ru'], TEMPLATE_DIR), output);
  assert.equal(fs.readFileSync(output, 'utf8'), html);
});

test('CLI refuses to overwrite a page it did not make, and needs a file', () => {
  const dir = workspace('data.json', '{}');
  fs.writeFileSync(path.join(dir, 'data.review.html'), '<p>mine</p>');
  assert.throws(() => run([path.join(dir, 'data.json')], TEMPLATE_DIR), /was not generated/);
  assert.throws(() => run([], TEMPLATE_DIR), /usage/);
});

test('the bundled generator needs only node and gives the same page', async () => {
  const dir = workspace('data.sql', 'CREATE TABLE t (a int);');
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'template.html'), path.join(dir, 'template.html'));
  const script = path.join(dir, 'build-review.cjs');
  await build({
    entryPoints: [path.join(__dirname, '../src/review/cli.js')], bundle: true, format: 'cjs', platform: 'node', outfile: script, logLevel: 'silent',
  });
  const out = execFileSync(process.execPath, [script, path.join(dir, 'data.sql')], { encoding: 'utf8' }).trim();
  assert.equal(fs.readFileSync(out, 'utf8'), make('CREATE TABLE t (a int);', 'sql'));
});
