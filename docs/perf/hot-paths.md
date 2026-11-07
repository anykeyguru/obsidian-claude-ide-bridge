# Hot paths

Run: `node --expose-gc docs/perf/hot-paths.bench.cjs`. Three runs after a warm-up, Node 22. V8 exposes no allocs/op, so heap growth during the run stands in for B/op.

| Fork | Variant | ms/op (runs) | Heap growth | Chosen |
|---|---|---|---|---|
| Line number near the end of a 30 MB text | `slice` + `split` | 49.7, 48.8, 47.7 | 210 MB | |
| | `indexOf` loop | 8.6, 8.8, 8.5 | 0 | yes |
| Receive a 32 MB frame in 64 KB chunks | `concat` per chunk | 728, 725, 788 | not measurable, collected at once | |
| | chunk list, one `concat` | 0.99, 0.54, 0.54 | same | yes |
| First page of a 30 MB CSV | parse the whole file | 200, 181, 198 | 878 MB | |
| | parse one page | 0.74, 0.16, 0.12 | 1 MB | yes |
