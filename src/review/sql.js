'use strict';

// Reads table structure from SQL text, whatever the dialect: CREATE TABLE
// statements with COMMENT ON, or a pasted list of `name type` lines.

const TYPE_ENDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'COMMENT', 'CHECK', 'CONSTRAINT',
  'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COLLATE', 'ENCODE', 'CODEC', 'IDENTITY', 'ON',
]);
const TABLE_CLAUSES = new Set(['PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN', 'KEY', 'INDEX', 'CHECK', 'EXCLUDE', 'LIKE', 'PERIOD']);

function readQuoted(sql, start, close) {
  let value = '';
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] !== close) return { value, end: i + 1 };
      value += close;
      i += 2;
    } else {
      value += sql[i];
      i += 1;
    }
  }
  throw new Error('Unclosed quote in SQL');
}

const WORD = /[\p{L}\p{N}_$@#.]/u;

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'") {
      const { value, end } = readQuoted(sql, i, "'");
      tokens.push({ kind: 'string', value });
      i = end;
    } else if (c === '"' || c === '`' || c === '[') {
      const { value, end } = readQuoted(sql, i, c === '[' ? ']' : c);
      tokens.push({ kind: 'name', value });
      i = end;
    } else if (WORD.test(c)) {
      let end = i + 1;
      while (end < sql.length && WORD.test(sql[end])) end += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, end) });
      i = end;
    } else {
      tokens.push({ kind: 'mark', value: c });
      i += 1;
    }
  }
  return tokens;
}

const keyword = (token) => (token && token.kind === 'word' ? token.value.toUpperCase() : '');
const isMark = (token, value) => !!token && token.kind === 'mark' && token.value === value;
const lastPart = (name) => name.split('.').pop();

function splitStatements(tokens) {
  const statements = [[]];
  for (const token of tokens) {
    if (isMark(token, ';')) statements.push([]);
    else statements[statements.length - 1].push(token);
  }
  return statements.filter((s) => s.length);
}

// Commas between column definitions, not those inside `numeric(10, 2)`.
function splitColumns(tokens) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isMark(token, '(')) depth += 1;
    if (isMark(token, ')')) depth -= 1;
    if (depth === 0 && isMark(token, ',')) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts.filter((p) => p.length);
}

function closingParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isMark(tokens[i], '(')) depth += 1;
    if (isMark(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced parentheses in CREATE TABLE');
}

function textOf(tokens) {
  let text = '';
  tokens.forEach((token, i) => {
    const tight = i === 0 || isMark(token, ')') || isMark(token, ',') || isMark(token, '(') || isMark(tokens[i - 1], '(');
    text += (tight ? '' : ' ') + (token.kind === 'string' ? `'${token.value}'` : token.value);
  });
  return text;
}

// Tokens of one value: a parenthesised group, or a word with optional call.
function valueEnd(tokens, start) {
  if (isMark(tokens[start], '(')) return closingParen(tokens, start) + 1;
  return isMark(tokens[start + 1], '(') ? closingParen(tokens, start + 1) + 1 : start + 1;
}

function namesIn(tokens) {
  const open = tokens.findIndex((t) => isMark(t, '('));
  if (open < 0) return [];
  return splitColumns(tokens.slice(open + 1, closingParen(tokens, open))).map((part) => part[0].value);
}

function parseColumn(tokens) {
  const column = {
    name: tokens[0].value, type: '', nullable: true, key: '', default: '', references: '', comment: '',
  };
  let i = 1;
  const typeStart = i;
  while (i < tokens.length && !TYPE_ENDS.has(keyword(tokens[i]))) i += isMark(tokens[i], '(') ? closingParen(tokens, i) - i + 1 : 1;
  column.type = textOf(tokens.slice(typeStart, i));
  while (i < tokens.length) {
    const word = keyword(tokens[i]);
    if (word === 'NOT' && keyword(tokens[i + 1]) === 'NULL') {
      column.nullable = false;
      i += 2;
    } else if (word === 'PRIMARY') {
      column.key = 'PRIMARY';
      column.nullable = false;
      i += 2;
    } else if (word === 'UNIQUE') {
      column.key = column.key || 'UNIQUE';
      i += 1;
    } else if (word === 'DEFAULT') {
      const end = valueEnd(tokens, i + 1);
      column.default = textOf(tokens.slice(i + 1, end));
      i = end;
    } else if (word === 'REFERENCES') {
      const end = valueEnd(tokens, i + 1);
      column.references = textOf(tokens.slice(i + 1, end));
      i = end;
    } else if (word === 'COMMENT' && tokens[i + 1] && tokens[i + 1].kind === 'string') {
      column.comment = tokens[i + 1].value;
      i += 2;
    } else {
      i += 1;
    }
  }
  return column;
}

function applyTableClause(tokens, table) {
  const words = tokens.map(keyword);
  const clause = words.indexOf('CONSTRAINT') === 0 ? words.slice(2) : words;
  const body = words.indexOf('CONSTRAINT') === 0 ? tokens.slice(2) : tokens;
  const byName = (name) => table.columns.find((c) => c.name === name);
  if (clause[0] === 'PRIMARY') {
    for (const name of namesIn(body)) {
      const column = byName(name);
      if (column) { column.key = 'PRIMARY'; column.nullable = false; }
    }
  } else if (clause[0] === 'UNIQUE') {
    for (const name of namesIn(body)) {
      const column = byName(name);
      if (column) column.key = column.key || 'UNIQUE';
    }
  } else if (clause[0] === 'FOREIGN') {
    const at = clause.indexOf('REFERENCES');
    const [name] = namesIn(body.slice(0, at));
    const column = byName(name);
    if (column) column.references = textOf(body.slice(at + 1, valueEnd(body, at + 1)));
  }
}

function parseCreateTable(tokens) {
  const open = tokens.findIndex((t) => isMark(t, '('));
  if (open < 0) throw new Error('CREATE TABLE without columns');
  const close = closingParen(tokens, open);
  const nameToken = tokens[open - 1];
  const table = { name: lastPart(nameToken.value), comment: '', columns: [] };
  const parts = splitColumns(tokens.slice(open + 1, close));
  const clauses = [];
  for (const part of parts) {
    if (part[0].kind === 'word' && TABLE_CLAUSES.has(keyword(part[0]))) clauses.push(part);
    else table.columns.push(parseColumn(part));
  }
  clauses.forEach((clause) => applyTableClause(clause, table));
  const after = tokens.slice(close + 1);
  const comment = after.findIndex((t) => keyword(t) === 'COMMENT');
  if (comment >= 0) {
    const value = after.slice(comment + 1).find((t) => t.kind === 'string');
    if (value) table.comment = value.value;
  }
  return table;
}

function applyComment(tokens, tables) {
  const value = tokens.find((t) => t.kind === 'string');
  const target = tokens.slice(3).filter((t) => t.kind !== 'mark' && t.kind !== 'string' && keyword(t) !== 'IS').map((t) => t.value).join('.').split('.');
  if (!value) return;
  if (keyword(tokens[2]) === 'TABLE') {
    const table = tables.find((t) => t.name === target[target.length - 1]);
    if (table) table.comment = value.value;
  } else if (keyword(tokens[2]) === 'COLUMN') {
    const table = tables.find((t) => t.name === target[target.length - 2]);
    const column = table && table.columns.find((c) => c.name === target[target.length - 1]);
    if (column) column.comment = value.value;
  }
}

function parsePastedColumns(text) {
  const columns = [];
  for (const line of text.split('\n')) {
    const clean = line.trim().replace(/,$/, '');
    if (clean && !clean.startsWith('--')) {
      const tokens = tokenize(clean);
      if (tokens.length < 2) throw new Error(`Not a column definition: ${clean}`);
      columns.push(parseColumn(tokens));
    }
  }
  return columns.length ? [{ name: 'columns', comment: '', columns }] : [];
}

function parseSqlTables(sql) {
  const statements = splitStatements(tokenize(sql));
  const tables = [];
  for (const tokens of statements) {
    if (keyword(tokens[0]) === 'CREATE' && tokens.slice(1, 5).some((t) => keyword(t) === 'TABLE')) tables.push(parseCreateTable(tokens));
  }
  if (!tables.length) {
    const pasted = parsePastedColumns(sql);
    if (!pasted.length) throw new Error('No tables or columns found in SQL');
    return pasted;
  }
  for (const tokens of statements) {
    if (keyword(tokens[0]) === 'COMMENT' && keyword(tokens[1]) === 'ON') applyComment(tokens, tables);
  }
  return tables;
}

module.exports = { parseSqlTables, tokenize };
