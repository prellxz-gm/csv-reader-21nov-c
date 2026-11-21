# Tick-Hunter — a faster csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/prellxz-gm/csv-reader-21nov-c/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/prellxz-gm/csv-reader-21nov-c/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

Entry for [Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121): a faster drop-in for make.fun's own csv-reader 1.0.0. `solve.js` exports `run(input)`, which returns exactly what csv-reader returns for every `{text, header}` — `{columns, rows, errors}` — including every broken-row case (short/long rows, stray CRs, quote junk, unterminated quotes, BOM, blank lines, CRLF/LF mix).

## How it is fast

The reference reads one character at a time. Tick-Hunter scans with native
`indexOf` / `slice` instead:

- One pre-pass collects every `\r` position, so testing a field for a stray CR
  is a single integer compare against a cached count.
- The next `\n` is cached per line, together with whether that line ends in
  CRLF, so an unquoted field costs one `indexOf(',')` plus one `slice`.
- A quoted field costs one `indexOf('"')` to find its close (doubled quotes
  skipped in pairs) plus one `slice` when its content holds no line break and
  no lone CR.
- Only the rare broken shapes — a stray CR inside an unquoted field, a quoted
  field holding line breaks, junk after a closing quote, a quote that never
  closes — fall back to a careful reader.

## Verification

- Practice set: **6/6 identical** to the reference answers.
- Differential fuzzing against csv-reader 1.0.0: **2061/2061 match**
  (61 hand-written edge cases plus 2000 random CSVs covering short/long rows,
  stray CRs including `\r\r\n` and a lone CR at EOF, quote junk including
  `x"y`, blank lines, BOM, CRLF/LF mix, unterminated quotes at EOF and
  mid-file, empty text, header and no-header, no trailing EOL).
- Local timing of `run()` over the 6 practice cases (10 warm passes,
  `process.cpuUsage`): **best 61.6 ms, median ~66 ms**, against roughly
  640–980 ms for the reference on the same machine — about 10–13x faster.

## Files

- `solve.js` — the entry: `export function run(input)`.
- `main.ts` — the house driver (unchanged), with `--no-incremental-marking`.
- `package.json` — `{ "type": "module" }`.

## License

MIT
