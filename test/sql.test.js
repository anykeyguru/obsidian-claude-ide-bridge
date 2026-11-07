'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { parseSqlTables, tokenize } = require('../src/review/sql');

const column = (table, name) => table.columns.find((c) => c.name === name);

test('reads a Postgres table with constraints and comments', () => {
  const [table] = parseSqlTables(`
    -- the orders
    CREATE TABLE IF NOT EXISTS public.orders (
      id bigserial PRIMARY KEY,
      total numeric(10, 2) NOT NULL DEFAULT 0,
      status varchar(20) DEFAULT 'new',
      created_at timestamp with time zone DEFAULT now(),
      customer_id bigint REFERENCES customers(id),
      note text
    );
    COMMENT ON TABLE public.orders IS 'All orders';
    COMMENT ON COLUMN public.orders.total IS 'Order''s total';
  `);
  assert.equal(table.name, 'orders');
  assert.equal(table.comment, 'All orders');
  assert.deepEqual(column(table, 'id'), {
    name: 'id', type: 'bigserial', nullable: false, key: 'PRIMARY', default: '', references: '', comment: '',
  });
  const total = column(table, 'total');
  assert.deepEqual([total.type, total.nullable, total.default, total.comment], ['numeric(10, 2)', false, '0', "Order's total"]);
  assert.equal(column(table, 'status').default, "'new'");
  assert.equal(column(table, 'created_at').type, 'timestamp with time zone');
  assert.equal(column(table, 'created_at').default, 'now()');
  assert.equal(column(table, 'customer_id').references, 'customers(id)');
  assert.equal(column(table, 'note').nullable, true);
});

test('reads MySQL quoting, inline comments and a table comment', () => {
  const [table] = parseSqlTables("CREATE TABLE `users` (`id` INT NOT NULL AUTO_INCREMENT COMMENT 'Key', `mail` VARCHAR(50) UNIQUE, PRIMARY KEY (`id`)) ENGINE=InnoDB COMMENT='People';");
  assert.equal(table.comment, 'People');
  assert.equal(column(table, 'id').comment, 'Key');
  assert.equal(column(table, 'id').key, 'PRIMARY');
  assert.equal(column(table, 'mail').key, 'UNIQUE');
});

test('reads SQL Server brackets and double-quoted names', () => {
  const [table] = parseSqlTables('CREATE TABLE [dbo.items] ([a b] int, "c""d" int);');
  assert.equal(table.name, 'items');
  assert.deepEqual(table.columns.map((c) => c.name), ['a b', 'c"d']);
});

test('reads table clauses: composite keys, unique, foreign keys, named constraints', () => {
  const [table] = parseSqlTables(`CREATE TABLE t (
    a int, b int, c int, d int,
    CONSTRAINT pk_t PRIMARY KEY (a, b),
    UNIQUE (c),
    FOREIGN KEY (d) REFERENCES other (id),
    CHECK (a > 0),
    PRIMARY KEY (missing), UNIQUE (missing), FOREIGN KEY (missing) REFERENCES x (y)
  );`);
  assert.deepEqual([column(table, 'a').key, column(table, 'b').key, column(table, 'c').key], ['PRIMARY', 'PRIMARY', 'UNIQUE']);
  assert.equal(column(table, 'a').nullable, false);
  assert.equal(column(table, 'd').references, 'other(id)');
  assert.equal(table.columns.length, 4);
});

test('a default in parentheses and a column with no type', () => {
  const [table] = parseSqlTables('CREATE TABLE t (a int DEFAULT (1 + 2), b, c int UNIQUE PRIMARY KEY, d int CHECK (d > 0));');
  assert.equal(column(table, 'a').default, '(1 + 2)');
  assert.equal(column(table, 'b').type, '');
  assert.equal(column(table, 'c').key, 'PRIMARY');
  assert.equal(column(table, 'd').type, 'int');
});

test('reads several tables and skips other statements', () => {
  const tables = parseSqlTables('DROP TABLE a; CREATE TEMPORARY TABLE b (x int); INSERT INTO b VALUES (1); CREATE TABLE c (y int);');
  assert.deepEqual(tables.map((t) => t.name), ['b', 'c']);
});

test('ignores comments for unknown targets', () => {
  const [table] = parseSqlTables("CREATE TABLE a (x int); COMMENT ON TABLE b IS 'no'; COMMENT ON COLUMN a.y IS 'no'; COMMENT ON COLUMN b.y IS 'no'; COMMENT ON TABLE a IS NULL; COMMENT ON INDEX a IS 'no';");
  assert.equal(table.comment, '');
  assert.equal(column(table, 'x').comment, '');
});

test('reads a pasted list of columns', () => {
  const [table] = parseSqlTables(`
    id bigint NOT NULL,
    -- a note
    name varchar(20)
  `);
  assert.equal(table.name, 'columns');
  assert.deepEqual(table.columns.map((c) => [c.name, c.type, c.nullable]), [['id', 'bigint', false], ['name', 'varchar(20)', true]]);
});

test('reports text that is not SQL', () => {
  assert.throws(() => parseSqlTables(''), /No tables or columns/);
  assert.throws(() => parseSqlTables('hello'), /Not a column definition/);
  assert.throws(() => parseSqlTables("CREATE TABLE t (a varchar DEFAULT 'x"), /Unclosed quote/);
  assert.throws(() => parseSqlTables('CREATE TABLE t (a int'), /Unbalanced/);
  assert.throws(() => parseSqlTables('CREATE TABLE t AS SELECT 1'), /without columns/);
});

test('tokenizer drops comments, also an unclosed one', () => {
  assert.deepEqual(tokenize('a /* b */ c -- d').map((t) => t.value), ['a', 'c']);
  assert.deepEqual(tokenize('a /* b').map((t) => t.value), ['a']);
  assert.deepEqual(tokenize('-- only').map((t) => t.value), []);
});

test('names may be in any alphabet', () => {
  const [table] = parseSqlTables('CREATE TABLE заказы (сумма numeric);');
  assert.equal(table.name, 'заказы');
  assert.equal(table.columns[0].name, 'сумма');
});
