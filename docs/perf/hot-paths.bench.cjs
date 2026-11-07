'use strict';
// node --expose-gc docs/perf/hot-paths.bench.cjs
const { lineAt } = require('../../src/selection');
const { parseDelimited } = require('../../src/formats/csv');

const MB = 1024 * 1024;

function measure(fn, iterations) {
  global.gc();
  const heap = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  let keep;
  for (let i = 0; i < iterations; i += 1) keep = fn();
  const ns = Number(process.hrtime.bigint() - started) / iterations;
  const peak = process.memoryUsage().heapUsed - heap;
  return { ns, peak, keep };
}

function report(group, variants, iterations) {
  for (const [name, fn] of Object.entries(variants)) {
    measure(fn, 1);
    for (let count = 1; count <= 3; count += 1) {
      const { ns, peak } = measure(fn, iterations);
      console.log(`${group}\t${name}\t${count}\t${(ns / 1e6).toFixed(3)} ms/op\t${(peak / MB).toFixed(1)} MB heap growth`);
    }
  }
}

// Line number of a selection near the end of a 30 MB text.
const text = 'some line of text in a file\n'.repeat(1100000);
const offset = text.length - 10;
report('line-number', {
  'slice+split': () => text.slice(0, offset).split('\n').length,
  indexOf: () => lineAt(text, offset),
}, 5);

// Receiving a 32 MB frame in 64 KB chunks.
const chunks = Array.from({ length: 512 }, () => Buffer.alloc(64 * 1024));
report('ws-receive', {
  'concat-per-chunk': () => {
    let buf = Buffer.alloc(0);
    for (const chunk of chunks) buf = Buffer.concat([buf, chunk]);
    return buf.length;
  },
  'chunk-list': () => Buffer.concat(chunks).length,
}, 3);

// First page of a 30 MB CSV.
const csv = 'id,name,value,date\n'.concat('12345,some name,12.5,2026-11-07\n'.repeat(950000));
report('csv-first-page', {
  'whole-file': () => parseDelimited(csv, ',').rows.slice(0, 1000),
  'one-page': () => parseDelimited(csv, ',', 0, 1000).rows,
}, 3);
