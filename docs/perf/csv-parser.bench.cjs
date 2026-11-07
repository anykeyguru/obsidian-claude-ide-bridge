'use strict';
// node --expose-gc docs/perf/csv-parser.bench.cjs   (needs: npm i --no-save papaparse)
const Papa = require('papaparse');
const { parseDelimited } = require('../../src/formats/csv');

const ROWS = 100000;
const makeRow = (i, field) => `${i},${field},"quoted, ""text"" ${i}",12.5,2026-11-07\n`;
const inputs = {
  'plain': Array.from({ length: ROWS }, (_, i) => `${i},name${i},value,12.5,2026-11-07\n`).join(''),
  'quoted': Array.from({ length: ROWS }, (_, i) => makeRow(i, `name${i}`)).join(''),
};
const parsers = {
  own: (t) => parseDelimited(t, ',').rows,
  papaparse: (t) => Papa.parse(t, { delimiter: ',' }).data,
};

function run(parse, text) {
  const iterations = 20;
  global.gc();
  const heap = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  let keep;
  for (let i = 0; i < iterations; i += 1) keep = parse(text);
  const ns = Number(process.hrtime.bigint() - started) / iterations;
  global.gc();
  const retained = process.memoryUsage().heapUsed - heap;
  return { ns, retained, rows: keep.length, keep };
}

for (const [name, text] of Object.entries(inputs)) {
  for (const [parser, parse] of Object.entries(parsers)) {
    run(parse, text); // warm up
    for (let count = 1; count <= 3; count += 1) {
      const r = run(parse, text);
      console.log(`${name}\t${parser}\t${count}\t${Math.round(r.ns / ROWS)} ns/row\t${(r.ns / 1e6).toFixed(1)} ms/op\t${Math.round(r.retained / ROWS)} B/row`);
    }
  }
}
