'use strict';

// Turns structured data into a review page. The output depends only on the
// input: no clocks, no random ids, keys in source order. Rebuilding a file keeps
// its comments, because item ids come from table names and key paths.

const { parseAllDocuments } = require('yaml');
const { parseToml } = require('../formats/toml');
const { parseJsonLines } = require('../formats/jsonl');
const { parseDelimited, detectSeparator } = require('../formats/csv');
const { MAX_REVIEW_SOURCE_BYTES, REVIEW_SAMPLE_ROWS } = require('../limits');
const { parseSqlTables } = require('./sql');
const { languageOf } = require('./labels');

const GENERATOR = '<meta name="generator" content="claude-ide-bridge review">';
const ABSENT = '—';

function parseYamlDocuments(text) {
  const documents = parseAllDocuments(text);
  const failed = documents.find((doc) => doc.errors.length);
  if (failed) throw new Error(failed.errors[0].message);
  return documents.map((doc) => doc.toJS());
}

function rowsToObjects(text, separator) {
  const { rows } = parseDelimited(text, separator, 0, REVIEW_SAMPLE_ROWS + 1);
  const [header = [], ...body] = rows;
  return body.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

function sqlDocuments(text, language) {
  const words = language.sql;
  return {
    attributes: [
      { key: 'nullable', label: words.nullable },
      { key: 'key', label: words.key },
      { key: 'default', label: words.default },
      { key: 'references', label: words.references },
      { key: 'owner', label: words.owner },
    ],
    documents: parseSqlTables(text).map((table) => ({
      key: table.name,
      tab: table.name,
      value: Object.fromEntries(table.columns.map((c) => [c.name, c.type])),
      fields: Object.fromEntries(table.columns.map((c) => [`${table.name}:${c.name}`, {
        type: c.type,
        title: c.comment,
        nullable: c.nullable ? words.yes : words.no,
        // The schema does settle these, so an absent one is a dash, not a blank to fill.
        key: c.key || ABSENT,
        default: c.default || ABSENT,
        references: c.references || ABSENT,
      }])),
    })),
  };
}

const single = (name, value) => ({ documents: [{ key: 'data', tab: name, value }] });

const SOURCES = {
  json: (text, name) => single(name, JSON.parse(text)),
  jsonl: (text, name) => single(name, parseJsonLines(text).slice(0, REVIEW_SAMPLE_ROWS)),
  yaml(text, name) {
    const documents = parseYamlDocuments(text);
    if (documents.length === 1) return single(name, documents[0]);
    return { documents: documents.map((value, i) => ({ key: `doc${i + 1}`, tab: `${name} ${i + 1}`, value })) };
  },
  toml: (text, name) => single(name, parseToml(text)),
  csv: (text, name) => single(name, rowsToObjects(text, detectSeparator(text))),
  tsv: (text, name) => single(name, rowsToObjects(text, '\t')),
  sql: (text, name, language) => sqlDocuments(text, language),
};
SOURCES.ndjson = SOURCES.jsonl;
SOURCES.yml = SOURCES.yaml;

const SOURCE_EXTENSIONS = Object.keys(SOURCES);

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

// Inside <script>: `<` must not be able to close the tag.
const scriptJson = (value) => JSON.stringify(value, null, 2).replace(/</g, '\\u003c');

function between(text, start, end, replacement) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Template has no ${start}`);
  return text.slice(0, from + start.length) + replacement + text.slice(to);
}

function compactFields(fields) {
  const result = {};
  for (const [path, field] of Object.entries(fields)) {
    result[path] = Object.fromEntries(Object.entries(field).filter(([, value]) => value !== ''));
  }
  return result;
}

// `meta` comes from <name>.fields.yaml: anything it sets wins over what was
// read from the data, so a person's classes and titles survive a rebuild.
function buildContract(source, language, meta) {
  const documents = {};
  let fields = {};
  for (const document of source.documents) {
    documents[document.key] = document.value;
    fields = { ...fields, ...document.fields };
  }
  const merged = compactFields(fields);
  for (const [path, field] of Object.entries(meta.fields || {})) {
    const known = path in merged ? path : Object.keys(merged).find((k) => k.split(':')[1] === path) || path;
    merged[known] = { ...merged[known], ...field };
  }
  const { groups, classes, statuses, statusLabel } = language.contract;
  return {
    groups: meta.groups || groups,
    classes: meta.classes || classes,
    statusLabel: meta.statusLabel || statusLabel,
    statuses: meta.statuses || statuses,
    attributes: meta.attributes || source.attributes || language.contract.attributes,
    documents,
    fields: merged,
  };
}

function buildReviewHtml({
  template, text, extension, name, title = name, lang = 'en', meta = {},
}) {
  const parse = SOURCES[extension.toLowerCase()];
  if (!parse) throw new Error(`Cannot build a review page from .${extension}`);
  if (text.length > MAX_REVIEW_SOURCE_BYTES) throw new Error(`File is over ${MAX_REVIEW_SOURCE_BYTES / (1024 * 1024)} MB`);
  const code = meta.lang || lang;
  const language = languageOf(code);
  const shownTitle = meta.title || title;
  const source = parse(text, name, language);
  const sections = source.documents
    .map((d) => `  <section data-tab="${escapeHtml(d.tab)}">\n    <div data-json="${escapeHtml(d.key)}"></div>\n  </section>\n`)
    .join('');
  let page = between(template, '<main>\n', '</main>', sections);
  page = between(page, '<script type="application/json" id="contract">', '</script>', `\n${scriptJson(buildContract(source, language, meta))}\n`);
  page = between(page, '/* LABELS */ ', ' /* /LABELS */', scriptJson(language.labels));
  return page
    .replace('<html lang="en">', () => `<html lang="${escapeHtml(code)}">\n${GENERATOR}`)
    .replaceAll('__DOC_NAME__', () => `${name}.review`)
    .replaceAll('__TITLE__', () => escapeHtml(shownTitle));
}

const isGeneratedPage = (html) => html.includes(GENERATOR);

// <name>.fields.yaml / .yml / .json are read the same way.
function parseMeta(text) {
  const [meta = {}] = parseYamlDocuments(text);
  return meta || {};
}

module.exports = {
  buildReviewHtml, parseMeta, isGeneratedPage, SOURCE_EXTENSIONS,
};
