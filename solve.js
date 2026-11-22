// solve.js — v8: WASM SIMD CSV reader (fresh design, UTF-8 byte-level transducer).
// The WASM module (parser.wasm, AssemblyScript) parses CSV bytes and emits the
// JSON answer bytes directly. run() returns the JS structure (for the harness /
// difftest); runBytes() returns the raw JSON bytes (for main.ts streaming emit,
// which avoids JSON.parse + JSON.stringify entirely in the driver path).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmBytes = fs.readFileSync(path.join(__dirname, 'parser.wasm'));
const mod = new WebAssembly.Module(wasmBytes);
const inst = new WebAssembly.Instance(mod, {});
const { memory, parse, inPtr, outPtr } = inst.exports;
const mem = new Uint8Array(memory.buffer);
const IN = inPtr();
const OUT = outPtr();
const IN_CAP = 8 * 1024 * 1024; // must match parser.ts IN region (8 MiB)
const enc = new TextEncoder();
const dec = new TextDecoder();

function transduce(input) {
  const bytes = enc.encode(input.text);
  if (bytes.length > IN_CAP) throw new Error('v8: input exceeds 8 MiB WASM input region');
  mem.set(bytes, IN);
  const outLen = parse(bytes.length, input.header ? 1 : 0);
  return mem.subarray(OUT, OUT + outLen);
}

/** The answer for one case's input, as a JS structure {columns, rows, errors}. */
export function run(input) {
  return JSON.parse(dec.decode(transduce(input)));
}

/** The answer for one case's input, as raw JSON bytes (Uint8Array view into WASM memory).
 *  The view is only valid until the next transduce call; write it before calling again. */
export function runBytes(input) {
  return transduce(input);
}

/** The answer for one case's input, as a JSON string. */
export function runJson(input) {
  return dec.decode(transduce(input));
}
