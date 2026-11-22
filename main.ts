// main.ts — v8 driver: streaming emit.
// Reads every case from /input/cases.json (or MAKEFUN_INPUT_DIR), answers each
// one alone with runBytes() from solve.js (the WASM transducer's raw JSON bytes),
// and writes /output/answers.json (or MAKEFUN_OUTPUT_DIR) as a JSON array of
// the answers, one per case and in the cases' order — byte-identical to
// JSON.stringify(answers) of the baseline driver, but without ever building
// the 11.6 MB answer string or the 793k-field JS structure in the driver.
// Each case's JSON bytes are written to the file as soon as they are produced,
// so the live heap stays one case wide.
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { runBytes } = (await import(new URL('./solve.js', import.meta.url).href)) as { runBytes: (input: unknown) => Uint8Array };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  writeSync(fd, runBytes(cases[i].input));
}
writeSync(fd, ']');
closeSync(fd);
