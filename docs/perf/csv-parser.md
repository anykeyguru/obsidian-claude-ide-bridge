# CSV parser: own vs PapaParse

100 000 rows, 5 fields, 20 iterations per run, `-count=3` equivalent (3 runs after a warm-up), Node 22.

Run: `npm i --no-save papaparse && node --expose-gc docs/perf/csv-parser.bench.cjs`

| Input | Parser | ns/row (runs) | ms/op, avg | Retained B/row |
|---|---|---|---|---|
| plain | own | 166, 163, 163 | 16.4 | 326 |
| plain | papaparse 5 | 216, 211, 216 | 21.4 | 232 |
| quoted | own | 273, 248, 249 | 25.7 | 480 |
| quoted | papaparse 5 | 361, 364, 355 | 36.0 | 480 |

`Retained` is the heap held by the parsed rows after GC. V8 exposes no allocs/op or total allocated bytes, so those are not measured.

Decision: own parser. It is 24-29% faster, adds no dependency, and detects `;` from the first line, which the view needs anyway. Its cost is about 40% more retained memory on unquoted input.
