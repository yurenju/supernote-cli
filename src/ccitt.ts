// Decodes CCITT Group 4 (ITU-T T.6) fax data, what PDF's CCITTFaxDecode filter holds
// when K < 0. Supernote Cloud uses it for some handwriting transparency masks. Each
// line is coded against the line above it (an all-white line for the first one), as
// the positions where the colour changes.

import { UnreadableMarkPdf } from "./errors.ts";

// Run-length codes from T.4, indexed by run length (terminating codes) or run / 64
// (make-up codes). The extended make-up codes, 1792 to 2560, are shared by both colours.
const WHITE_TERMINATING = "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100";
const WHITE_MAKEUP = "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011";
const BLACK_TERMINATING = "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111";
const BLACK_MAKEUP = "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101";
const EXTENDED_MAKEUP = "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111";

// The 2D coding modes. A vertical mode puts the next change `offset` from b1.
type Mode = { pass: true } | { horizontal: true } | { vertical: number } | { endOfBlock: true };
const MODES: [string, Mode][] = [
  ["1", { vertical: 0 }],
  ["011", { vertical: 1 }],
  ["000011", { vertical: 2 }],
  ["0000011", { vertical: 3 }],
  ["010", { vertical: -1 }],
  ["000010", { vertical: -2 }],
  ["0000010", { vertical: -3 }],
  ["001", { horizontal: true }],
  ["0001", { pass: true }],
  ["000000000001", { endOfBlock: true }],
];

/** A prefix code as a map from (length, bits) to its value. */
type CodeTable<T> = Map<number, T>;
const codeKey = (length: number, bits: number) => length * 0x10000 + bits;

function codeTable<T>(entries: [string, T][]): CodeTable<T> {
  return new Map(entries.map(([code, value]) => [codeKey(code.length, parseInt(code, 2)), value]));
}

function runTable(terminating: string, makeup: string): CodeTable<number> {
  const codes = (list: string, step: number, first: number) =>
    list.split(" ").map((code, i): [string, number] => [code, first + i * step]);
  return codeTable([...codes(terminating, 1, 0), ...codes(makeup, 64, 64), ...codes(EXTENDED_MAKEUP, 64, 1792)]);
}

const WHITE_RUNS = runTable(WHITE_TERMINATING, WHITE_MAKEUP);
const BLACK_RUNS = runTable(BLACK_TERMINATING, BLACK_MAKEUP);
const MODE_CODES = codeTable(MODES);
const LONGEST_CODE = 13;

class BitReader {
  private readonly data: Uint8Array;
  private pos = 0;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Reads the next code in `table`; reading past the end sees zero bits. */
  read<T>(table: CodeTable<T>): T {
    let bits = 0;
    for (let length = 1; length <= LONGEST_CODE; length++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      bits = (bits << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
      const value = table.get(codeKey(length, bits));
      if (value !== undefined) return value;
    }
    throw new UnreadableMarkPdf("CCITT data has an unknown code");
  }

  /** Reads a run of one colour: any make-up codes, then a terminating code. */
  readRun(white: boolean): number {
    let run = 0;
    for (;;) {
      const part = this.read(white ? WHITE_RUNS : BLACK_RUNS);
      run += part;
      if (part < 64) return run;
    }
  }
}

/** Decodes `height` lines of `width` pixels, one byte each: 1 for black, 0 for white. */
export function decodeG4(data: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  const reader = new BitReader(data);
  // Changing elements: where a line's colour flips, starting from white, ending with
  // `width` twice so every search finds one of either colour.
  let reference = [width, width];
  for (let y = 0; y < height; y++) {
    const changes: number[] = [];
    let a0 = -1;
    let white = true;
    let b1Index = 0;
    while (a0 < width) {
      // b1: the first change on the reference line right of a0 to the colour opposite
      // a0's. Changes at even indexes turn black, so white needs an even index.
      while (b1Index > 0 && reference[b1Index - 1]! > a0) b1Index--;
      while (reference[b1Index]! <= a0 || (b1Index % 2 === 0) !== white) b1Index++;
      const b1 = reference[b1Index]!;
      const mode = reader.read(MODE_CODES);
      if ("endOfBlock" in mode) throw new UnreadableMarkPdf("CCITT data ends before the image does");
      if ("pass" in mode) {
        const b2 = reference[b1Index + 1];
        if (b2 === undefined) throw new UnreadableMarkPdf("CCITT data is corrupt");
        a0 = b2;
      } else if ("vertical" in mode) {
        const a1 = b1 + mode.vertical;
        if (a1 < Math.max(a0, 0) || a1 > width) throw new UnreadableMarkPdf("CCITT data is corrupt");
        changes.push(a1);
        a0 = a1;
        white = !white;
      } else {
        const a1 = Math.max(a0, 0) + reader.readRun(white);
        const a2 = a1 + reader.readRun(!white);
        if (a2 > width) throw new UnreadableMarkPdf("CCITT data is corrupt");
        changes.push(a1, a2);
        a0 = a2;
      }
    }

    const row = pixels.subarray(y * width, (y + 1) * width);
    for (let i = 0; i < changes.length; i += 2) row.fill(1, changes[i], changes[i + 1] ?? width);
    reference = [...changes, width, width];
  }
  return pixels;
}
