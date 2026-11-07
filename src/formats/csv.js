'use strict';

const { TABLE_PAGE_ROWS } = require('../limits');

const COMMA = 44;
const SEMICOLON = 59;
const TAB = 9;
const QUOTE = 34;
const LF = 10;
const CR = 13;

// RFC 4180: quoted fields may hold separators, line breaks and doubled quotes.
// Reads at most `limit` rows from offset `start`; `next` is where to go on, or
// -1 at the end, so a huge file is parsed only as far as it is shown.
function parseDelimited(text, separator, start = 0, limit = Infinity) {
  const sep = separator.charCodeAt(0);
  const n = text.length;
  const rows = [];
  let row = [];
  let i = start === 0 && text.charCodeAt(0) === 0xfeff ? 1 : start;
  for (;;) {
    let value = '';
    if (text.charCodeAt(i) === QUOTE) {
      i += 1;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close < 0) {
          value += text.slice(i);
          i = n;
          break;
        }
        value += text.slice(i, close);
        i = close + 1;
        if (text.charCodeAt(i) !== QUOTE) break;
        value += '"';
        i += 1;
      }
    }
    let stop = i;
    while (stop < n) {
      const c = text.charCodeAt(stop);
      if (c === sep || c === LF || c === CR) break;
      stop += 1;
    }
    row.push(stop > i ? value + text.slice(i, stop) : value);
    i = stop;
    if (i < n && text.charCodeAt(i) === sep) {
      i += 1;
      continue;
    }
    if (row.length > 1 || row[0] !== '') rows.push(row);
    if (i >= n) return { rows, next: -1 };
    i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    if (i >= n) return { rows, next: -1 };
    if (rows.length >= limit) return { rows, next: i };
    row = [];
  }
}

// Spreadsheets in many locales export `;`, so the first line decides.
function detectSeparator(text) {
  const counts = new Map([[COMMA, 0], [SEMICOLON, 0], [TAB, 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) quoted = !quoted;
    else if (!quoted && (c === LF || c === CR)) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return String.fromCharCode(best);
}

function mount(host) {
  const root = host.createDiv('cib-table');
  return {
    update(text, file) {
      const separator = file.extension.toLowerCase() === 'tsv' ? '\t' : detectSeparator(text);
      const first = parseDelimited(text, separator, 0, 1);
      const [header = []] = first.rows;
      root.replaceChildren();
      const status = root.createDiv('cib-table-status');
      const table = root.createEl('table');
      const headRow = table.createEl('thead').createEl('tr');
      for (const cell of header) headRow.createEl('th', { text: cell });
      const body = table.createEl('tbody');
      const more = root.createEl('button', { cls: 'cib-more', text: `Show ${TABLE_PAGE_ROWS} more` });
      let next = first.next;
      let shown = 0;
      const showPage = () => {
        if (next !== -1) {
          const page = parseDelimited(text, separator, next, TABLE_PAGE_ROWS);
          next = page.next;
          shown += page.rows.length;
          for (const row of page.rows) {
            const tr = body.createEl('tr');
            for (const cell of row) tr.createEl('td', { text: cell });
          }
        }
        status.textContent = `${shown} rows, ${header.length} columns${next === -1 ? '' : ' so far'}`;
        more.toggleClass('is-hidden', next === -1);
      };
      more.addEventListener('click', showPage);
      showPage();
    },
  };
}

module.exports = {
  id: 'csv',
  extensions: ['csv', 'tsv'],
  icon: 'table',
  mount,
  parseDelimited,
  detectSeparator,
};
