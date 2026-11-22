// parser.ts — fresh WASM SIMD CSV reader (csv-reader 1.0.0 semantics) + JSON emitter.
// Written from scratch for the csv-reader-speed bounty, slot2-v8.
//
// DESIGN (byte-level UTF-8 transducer):
//   * Input arrives as UTF-8 bytes in linear memory. All scanning is byte-level;
//     ASCII delimiters (", ,, CR, LF) can never appear inside a multi-byte UTF-8
//     sequence, so SIMD scanning is safe for non-ASCII text.
//   * The parser is a single fused pass: it reads CSV fields AND emits the JSON
//     answer bytes directly (no intermediate JS strings, no field table). The
//     output JSON is byte-identical to JSON.stringify(readCsv(input)).
//   * Errors are emitted into a separate buffer as JSON objects, then spliced
//     into the answer's "errors" array at the end.
//   * A record's fields are first emitted to a scratch buffer as a comma-separated
//     list of JSON strings, with a per-field offset table; at record end the row
//     is assembled (padding short rows, cutting long rows) into the output.
//   * JSON escaping follows JSON.stringify exactly: " \ and control <0x20
//     (\b \f \n \r \t, else \u00XX lowercase hex); all other bytes pass through.
//
// MEMORY (512 pages = 32 MiB, fixed, zero growth):
//   IN   0x000000  8 MiB  input UTF-8 bytes
//   OUT  0x800000  8 MiB  output JSON bytes
//   ERR  0x1000000 2 MiB  error objects JSON (comma-separated, no brackets)
//   SCR  0x1200000 4 MiB  per-record field JSON (comma-separated, no brackets)
//   OFF  0x1600000 1 MiB  u32 field start offsets in SCR (262144 entries)
//   (0x1700000..0x2000000 spare)

// ---- layout constants ----
const IN: i32 = 0;
const OUT: i32 = 8 * 1024 * 1024;
const ERR: i32 = 16 * 1024 * 1024;
const SCR: i32 = 18 * 1024 * 1024;
const OFF: i32 = 22 * 1024 * 1024;
const OFF_CAP: i32 = 262144;

// ---- error codes ----
const E_STRAY: i32 = 0;   // stray_cr
const E_JUNK: i32 = 1;    // quote_junk
const E_UNTERM: i32 = 2;  // unterminated_quote
const E_SHORT: i32 = 3;   // short_row
const E_LONG: i32 = 4;    // long_row

// ---- field end status ----
const END_COMMA: i32 = 0;
const END_BREAK: i32 = 1;
const END_EOF: i32 = 2;
const END_UNTERM: i32 = 3;

// ---- parser state (reset per parse() call) ----
let pos: i32 = 0;          // input offset (bytes from IN)
let end: i32 = 0;          // input length
let line: i32 = 1;         // current 1-based line
let width: i32 = -1;       // record width (fields), -1 until first record
let headerFlag: i32 = 0;   // 1 if header row expected
let outPos: i32 = 0;       // output write cursor
let errPos: i32 = 0;       // error-buffer write cursor
let errCount: i32 = 0;     // errors emitted so far
let rowCount: i32 = 0;     // rows emitted so far
let recordLine: i32 = 1;   // line the current record starts on
let recordRow: i32 = 0;    // row index for current record's errors (-1 = null)
let columnsDone: i32 = 0;  // 1 once the first record (columns/row) was written
let scrPos: i32 = 0;       // scratch write cursor
let recQuoted: i32 = 0;    // 1 if the last field read was quoted

// ---- raw byte stores (return new cursor) ----
function p64(d: i32, v: i64): i32 { store<i64>(d, v); return d + 8; }
function p32(d: i32, v: i32): i32 { store<i32>(d, v); return d + 4; }
function p16(d: i32, v: i32): i32 { store<i16>(d, v as i16); return d + 2; }
function p8(d: i32, v: i32): i32 { store<u8>(d, v); return d + 1; }

// decimal ASCII for a non-negative i32
function pNum(d: i32, n: i32): i32 {
  if (n == 0) return p8(d, 0x30);
  let div: i32 = 1;
  while (n / div >= 10) div *= 10;
  while (div > 0) {
    d = p8(d, 0x30 + (n / div) % 10);
    div /= 10;
  }
  return d;
}

function hexDigit(v: i32): i32 {
  return v < 10 ? 0x30 + v : 0x61 + (v - 10);
}

// Emit one input byte with JSON escaping. Returns new cursor.
function emitByteEscaped(d: i32, b: i32): i32 {
  if (b == 0x22) { d = p8(d, 0x5c); return p8(d, 0x22); }        // \"
  if (b == 0x5c) { d = p8(d, 0x5c); return p8(d, 0x5c); }        // \\
  if (b == 0x08) { d = p8(d, 0x5c); return p8(d, 0x62); }        // \b
  if (b == 0x0c) { d = p8(d, 0x5c); return p8(d, 0x66); }        // \f
  if (b == 0x0a) { d = p8(d, 0x5c); return p8(d, 0x6e); }        // \n
  if (b == 0x0d) { d = p8(d, 0x5c); return p8(d, 0x72); }        // \r
  if (b == 0x09) { d = p8(d, 0x5c); return p8(d, 0x74); }        // \t
  if (b < 0x20) {                                                // \u00XX
    d = p8(d, 0x5c); d = p8(d, 0x75); d = p8(d, 0x30); d = p8(d, 0x30);
    d = p8(d, hexDigit(b >> 4)); return p8(d, hexDigit(b & 15));
  }
  return p8(d, b);
}

// Emit JSON-escaped bytes for [src, src+len). SIMD bulk-copy for clean 16-byte
// chunks (no 0x5C and no byte < 0x20); scalar escape otherwise. Returns new cursor.
function emitEscaped(d: i32, src: i32, len: i32): i32 {
  const bs = i8x16.splat(0x5c);
  const ctl = i8x16.splat(0x20);
  let i: i32 = 0;
  while (i + 16 <= len) {
    const v = v128.load(src + i);
    const m = v128.or(i8x16.eq(v, bs), i8x16.lt_u(v, ctl));
    if (i8x16.bitmask(m) == 0) {
      v128.store(d, v);
      d += 16;
      i += 16;
    } else {
      for (let j: i32 = 0; j < 16; j++) d = emitByteEscaped(d, load<u8>(src + i + j));
      i += 16;
    }
  }
  while (i < len) { d = emitByteEscaped(d, load<u8>(src + i)); i++; }
  return d;
}

// SIMD scan: first byte in {'"'(0x22), ','(0x2C), '\r'(0x0D), '\n'(0x0A)} in [p, e), else e.
function scanSpecial(p: i32, e: i32): i32 {
  const q = i8x16.splat(0x22);
  const c = i8x16.splat(0x2c);
  const r = i8x16.splat(0x0d);
  const n = i8x16.splat(0x0a);
  let i: i32 = p;
  // align to 16 (scalar prologue)
  while (i < e && (i & 15) != 0) {
    const b = load<u8>(i);
    if (b == 0x22 || b == 0x2c || b == 0x0d || b == 0x0a) return i;
    i++;
  }
  while (i + 16 <= e) {
    const v = v128.load(i);
    let m = i8x16.eq(v, q);
    m = v128.or(m, i8x16.eq(v, c));
    m = v128.or(m, i8x16.eq(v, r));
    m = v128.or(m, i8x16.eq(v, n));
    const mask = i8x16.bitmask(m);
    if (mask != 0) return i + ctz<i32>(mask);
    i += 16;
  }
  while (i < e) {
    const b = load<u8>(i);
    if (b == 0x22 || b == 0x2c || b == 0x0d || b == 0x0a) return i;
    i++;
  }
  return e;
}

// SIMD scan: first byte in {'"'(0x22), '\r'(0x0D), '\n'(0x0A)} in [p, e), else e.
// (for quoted fields: quote and line breaks are the only specials)
function scanQuote(p: i32, e: i32): i32 {
  const q = i8x16.splat(0x22);
  const r = i8x16.splat(0x0d);
  const n = i8x16.splat(0x0a);
  let i: i32 = p;
  while (i < e && (i & 15) != 0) {
    const b = load<u8>(i);
    if (b == 0x22 || b == 0x0d || b == 0x0a) return i;
    i++;
  }
  while (i + 16 <= e) {
    const v = v128.load(i);
    let m = i8x16.eq(v, q);
    m = v128.or(m, i8x16.eq(v, r));
    m = v128.or(m, i8x16.eq(v, n));
    const mask = i8x16.bitmask(m);
    if (mask != 0) return i + ctz<i32>(mask);
    i += 16;
  }
  while (i < e) {
    const b = load<u8>(i);
    if (b == 0x22 || b == 0x0d || b == 0x0a) return i;
    i++;
  }
  return e;
}

// Emit the error-code name into the error buffer. Returns new cursor.
function emitCode(d: i32, code: i32): i32 {
  if (code == E_STRAY)  return p64(d, 0x72635f7961727473); // "stray_cr"
  if (code == E_JUNK) { d = p64(d, 0x756a5f65746f7571); return p16(d, 0x6b6e); } // "quote_junk"
  if (code == E_UNTERM) { // "unterminated_quote"
    d = p64(d, 0x6e696d7265746e75);
    d = p64(d, 0x6f75715f64657461);
    return p16(d, 0x6574);
  }
  if (code == E_SHORT) { d = p64(d, 0x6f725f74726f6873); return p8(d, 0x77); } // "short_row"
  return p64(d, 0x776f725f676e6f6c); // "long_row"
}

// Emit one error object {"code":"...","line":L,"row":R[, ...]} into ERR.
// For E_SHORT: fields = field count (extra args ignored).
// For E_LONG: extraStart/extraEnd = SCR byte range of the extra fields JSON.
function emitError(code: i32, fields: i32, extraStart: i32, extraEnd: i32): void {
  if (errCount > 0) errPos = p8(errPos, 0x2c); // ','
  errPos = p64(errPos, 0x3a2265646f63227b); // '{"code":"'
  errPos = p8(errPos, 0x22);
  errPos = emitCode(errPos, code);
  errPos = p64(errPos, 0x22656e696c222c22); // '","line":'
  errPos = p8(errPos, 0x3a);
  errPos = pNum(errPos, recordLine);
  errPos = p32(errPos, 0x6f72222c); // ',"ro'  (first 4 of ',"row":')
  errPos = p16(errPos, 0x2277);     // 'w"'
  errPos = p8(errPos, 0x3a);        // ':'
  if (recordRow < 0) {
    errPos = p32(errPos, 0x6c6c756e); // 'null'
  } else {
    errPos = pNum(errPos, recordRow);
  }
  if (code == E_SHORT) {
    errPos = p64(errPos, 0x73646c656966222c); // ',"fields":'
    errPos = p16(errPos, 0x3a22);
    errPos = pNum(errPos, fields);
  } else if (code == E_LONG) {
    errPos = p64(errPos, 0x226172747865222c); // ',"extra":'
    errPos = p8(errPos, 0x3a);
    errPos = p8(errPos, 0x5b); // '['
    // copy the extra fields JSON (comma-separated strings) from SCR
    memory.copy(errPos, extraStart, extraEnd - extraStart);
    errPos += extraEnd - extraStart;
    errPos = p8(errPos, 0x5d); // ']'
  }
  errPos = p8(errPos, 0x7d); // '}'
  errCount++;
}

// ---- field content parsers (emit JSON-escaped content to SCR) ----

// Parse unquoted field content starting at pos; emit escaped content to SCR.
// Returns END_COMMA / END_BREAK / END_EOF.
function readUnquotedContent(): i32 {
  while (true) {
    const s = scanSpecial(IN + pos, IN + end);
    scrPos = emitEscaped(scrPos, IN + pos, s - pos);
    pos = s;
    if (pos >= end) return END_EOF;
    const b = load<u8>(IN + pos);
    if (b == 0x2c) { pos++; return END_COMMA; }            // ','
    if (b == 0x0a) { pos++; line++; return END_BREAK; }     // '\n'
    if (b == 0x0d) {
      if (pos + 1 < end && load<u8>(IN + pos + 1) == 0x0a) { pos += 2; line++; return END_BREAK; } // CRLF
      emitError(E_STRAY, 0, 0, 0); // lone CR: dropped, not a line break
      pos++;
      continue;
    }
    // b == 0x22: literal quote inside an unquoted field
    scrPos = emitByteEscaped(scrPos, 0x22);
    pos++;
  }
}

// Parse quoted field content; pos points at the opening '"'. Emit escaped
// content to SCR. Returns END_COMMA / END_BREAK / END_EOF / END_UNTERM.
// On END_UNTERM: scrPos rewound to the content start, pos/line reset to the
// opening quote, unterminated_quote recorded. Caller must then emit the
// literal '"' and call readUnquotedContent().
function readQuotedContent(): i32 {
  const open = pos;
  const openLine = line;
  const contentStart = scrPos;
  pos++; // skip opening quote
  while (true) {
    const s = scanQuote(IN + pos, IN + end);
    scrPos = emitEscaped(scrPos, IN + pos, s - pos);
    pos = s;
    if (pos >= end) {
      scrPos = contentStart;
      pos = open + 1;
      line = openLine;
      emitError(E_UNTERM, 0, 0, 0);
      return END_UNTERM;
    }
    const b = load<u8>(IN + pos);
    if (b == 0x22) {
      if (pos + 1 < end && load<u8>(IN + pos + 1) == 0x22) {
        scrPos = emitByteEscaped(scrPos, 0x22); // doubled quote -> one '"'
        pos += 2;
        continue;
      }
      pos++; // closing quote
      if (pos >= end) return END_EOF;
      const c = load<u8>(IN + pos);
      if (c == 0x2c) { pos++; return END_COMMA; }
      if (c == 0x0a) { pos++; line++; return END_BREAK; }
      if (c == 0x0d && pos + 1 < end && load<u8>(IN + pos + 1) == 0x0a) { pos += 2; line++; return END_BREAK; }
      // junk after the closing quote: read as unquoted, appending to the value
      const before = scrPos;
      const ended = readUnquotedContent();
      if (scrPos > before) emitError(E_JUNK, 0, 0, 0);
      return ended;
    }
    // b is \r or \n inside quotes: becomes '\n' in the value, line++
    scrPos = p8(scrPos, 0x5c);
    scrPos = p8(scrPos, 0x6e); // JSON escape "\n"
    line++;
    if (b == 0x0d && pos + 1 < end && load<u8>(IN + pos + 1) == 0x0a) pos += 2; else pos++;
  }
}

// Parse one record into SCR (comma-separated JSON strings, no brackets).
// Fills OFF with per-field start offsets. Returns field count, or -1 if the
// record is a single empty unquoted field (not a record).
function parseRecord(): i32 {
  let n: i32 = 0;
  let ended: i32 = END_COMMA;
  scrPos = SCR;
  while (true) {
    if (n > 0) scrPos = p8(scrPos, 0x2c); // ','
    store<u32>(OFF + n * 4, scrPos - SCR); // this field's start offset
    scrPos = p8(scrPos, 0x22); // opening JSON quote
    const quoted: i32 = (pos < end && load<u8>(IN + pos) == 0x22) ? 1 : 0;
    if (quoted == 1) {
      ended = readQuotedContent();
      if (ended == END_UNTERM) {
        scrPos = emitByteEscaped(scrPos, 0x22); // the opening quote is literal
        ended = readUnquotedContent();
      }
    } else {
      ended = readUnquotedContent();
    }
    scrPos = p8(scrPos, 0x22); // closing JSON quote
    recQuoted = quoted;
    n++;
    if (ended == END_COMMA) continue;
    break;
  }
  // single empty unquoted field -> not a record
  if (n == 1 && (scrPos - SCR) == 2 && recQuoted == 0) return -1;
  return n;
}

// Append the record in SCR (n fields, offsets in OFF) as a JSON row array to OUT.
// Applies short-row padding and long-row cutting; emits short_row/long_row.
function appendRow(n: i32): void {
  if (rowCount > 0) outPos = p8(outPos, 0x2c); // ','
  outPos = p8(outPos, 0x5b); // '['
  if (n <= width) {
    memory.copy(outPos, SCR, scrPos - SCR);
    outPos += scrPos - SCR;
    if (n < width) {
      emitError(E_SHORT, n, 0, 0);
      for (let i: i32 = n; i < width; i++) {
        outPos = p8(outPos, 0x2c); // ','
        outPos = p16(outPos, 0x2222); // '""'
      }
    }
  } else {
    const cutEnd = load<u32>(OFF + width * 4); // start offset of field #width
    memory.copy(outPos, SCR, cutEnd - 1); // first `width` fields (drop trailing ',')
    outPos += cutEnd - 1;
    emitError(E_LONG, 0, SCR + cutEnd, SCR + (scrPos - SCR));
  }
  outPos = p8(outPos, 0x5d); // ']'
  rowCount++;
}

// Write the fixed output prefix '{"columns":' + X + ',"rows":[' where X is
// '[]'/'null' (no-record case) — shared by both paths.
function writePrefixNoRecord(): void {
  outPos = p64(outPos, 0x6e6d756c6f63227b); // '{"columns":'
  outPos = p16(outPos, 0x2273); // 's"'
  outPos = p8(outPos, 0x3a); // ':'
  if (headerFlag == 1) outPos = p16(outPos, 0x5d5b); // '[]'
  else outPos = p32(outPos, 0x6c6c756e); // 'null'
  outPos = p64(outPos, 0x3a2273776f72222c); // ',"rows":['
  outPos = p8(outPos, 0x5b);
}

// Main entry: parse the UTF-8 bytes at IN (length inputLen) with the header flag.
// Returns the output JSON byte length (bytes at OUT).
export function parse(inputLen: i32, header: i32): i32 {
  end = inputLen;
  pos = 0;
  line = 1;
  width = -1;
  headerFlag = header;
  outPos = OUT;
  errPos = ERR;
  errCount = 0;
  rowCount = 0;
  columnsDone = 0;
  // BOM: U+FEFF = EF BB BF
  if (inputLen >= 3 && load<u8>(IN) == 0xef && load<u8>(IN + 1) == 0xbb && load<u8>(IN + 2) == 0xbf) pos = 3;

  while (true) {
    // skip empty lines (\n or \r\n only; a lone \r is NOT skipped)
    while (pos < end) {
      const b = load<u8>(IN + pos);
      if (b == 0x0a) { pos++; line++; }
      else if (b == 0x0d && pos + 1 < end && load<u8>(IN + pos + 1) == 0x0a) { pos += 2; line++; }
      else break;
    }
    if (pos >= end) break;
    recordLine = line;
    recordRow = (headerFlag == 1 && columnsDone == 0) ? -1 : rowCount;
    const n = parseRecord();
    if (n < 0) continue; // skipped record; its errors are kept
    if (width < 0) {
      width = n;
      if (headerFlag == 1) {
        // this record is the columns
        outPos = p64(outPos, 0x6e6d756c6f63227b); // '{"columns":'
        outPos = p16(outPos, 0x2273); // 's"'
        outPos = p8(outPos, 0x3a); // ':'
        outPos = p8(outPos, 0x5b); // '['
        memory.copy(outPos, SCR, scrPos - SCR);
        outPos += scrPos - SCR;
        outPos = p8(outPos, 0x5d); // ']'
        outPos = p64(outPos, 0x3a2273776f72222c); // ',"rows":['
        outPos = p8(outPos, 0x5b);
        columnsDone = 1;
        continue;
      }
      // first record is a data row: write the prefix, then fall through to appendRow
      outPos = p64(outPos, 0x6e6d756c6f63227b); // '{"columns":'
      outPos = p16(outPos, 0x2273); // 's"'
      outPos = p8(outPos, 0x3a); // ':'
      outPos = p32(outPos, 0x6c6c756e); // 'null'
      outPos = p64(outPos, 0x3a2273776f72222c); // ',"rows":['
      outPos = p8(outPos, 0x5b);
      columnsDone = 1;
    }
    appendRow(n);
  }

  if (columnsDone == 0) writePrefixNoRecord();
  // close rows, open errors: '],"errors":['
  outPos = p64(outPos, 0x726f727265222c5d);
  outPos = p32(outPos, 0x5b3a2273);
  memory.copy(outPos, ERR, errPos - ERR);
  outPos += errPos - ERR;
  outPos = p16(outPos, 0x7d5d); // ']}'
  return outPos - OUT;
}

// Byte offset of the output JSON in linear memory (for the JS host).
export function outPtr(): i32 { return OUT; }
// Byte offset of the input area (for the JS host).
export function inPtr(): i32 { return IN; }
