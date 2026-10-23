import assert from "node:assert/strict";
import { test } from "node:test";
import { UnreadableMarkPdf } from "../src/errors.ts";
import { extractHandwriting } from "../src/handwriting.ts";
import { buildPdf, decodePng, handwritingImage } from "./pdf-fixture.ts";

const RED = [255, 0, 0, 255];

test("extractHandwriting turns a page's handwriting stamp into a transparent PNG", () => {
  const handwriting = handwritingImage(3, 2, [{ x: 1, y: 0, rgba: RED }]);
  const pages = extractHandwriting(buildPdf([{ handwriting: handwriting }]));

  assert.deepEqual(pages.map((p) => p.page), [1]);
  assert.deepEqual(decodePng(pages[0]!.png), handwriting);
});

test("extractHandwriting numbers pages as in the PDF and skips pages without handwriting", () => {
  const first = handwritingImage(2, 2, [{ x: 0, y: 0, rgba: RED }]);
  const third = handwritingImage(2, 2, [{ x: 1, y: 1, rgba: [0, 0, 0, 128] }]);
  const pages = extractHandwriting(buildPdf([{ handwriting: first }, {}, { handwriting: third }]));

  assert.deepEqual(pages.map((p) => p.page), [1, 3]);
  assert.deepEqual(decodePng(pages[1]!.png), third);
});

test("extractHandwriting follows an image length stored as its own object", () => {
  const handwriting = handwritingImage(4, 1, [{ x: 3, y: 0, rgba: RED }]);
  const pages = extractHandwriting(buildPdf([{ handwriting: handwriting, indirectLength: true }]));
  assert.deepEqual(decodePng(pages[0]!.png), handwriting);
});

// A 2700×11 mask, transparent except where `maskOpaque` says, CCITT G4-encoded by
// a separate encoder and checked against poppler's decoder. Its rows exercise every
// G4 coding mode and run lengths needing make-up codes, up to the 2560 extension.
const CCITT_MASK_WIDTH = 2700;
const CCITT_MASK_HEIGHT = 11;
const CCITT_MASK = Buffer.from(
  "JqA+GQHkIAl23ggcSA/Kw3JqB4ahfMAPAr4iQGBqwQJQLBrMOSHJDkhyQ5IckOSHJDkhyQ5IckOSHJDkhyQ5IckOSHJDkhyQ5IckOSHJDkhyQ5DJF34w2R2jxhBMxoEChhBCcdMECEocKcdkfRx88MjtHjCCZjQIFDCCE46YIEIiIiIjTEREREREREWIiIiIiIiIiIiQHgVh6KAfkeACACA=",
  "base64",
);

function maskOpaque(x: number, y: number): boolean {
  const between = (a: number, b: number) => x >= a && x <= b;
  switch (y) {
    case 0: return false;
    case 1: return between(10, 1999);
    case 2: return between(11, 2000);
    case 3: return between(8, 2003);
    case 4: return true;
    case 5: return between(100, 101) || between(104, 106) || between(2650, 2699);
    case 6: return between(2000, 2002);
    case 7: return (x % 7 === 3 && x < 200) || between(400, 470);
    case 8: return (x * x) % 13 < 4 && x < 150;
    case 9: return between(0, 0) || between(5, 70) || between(2690, 2690);
    default: return between(1, 2698);
  }
}

/** Black handwriting, opaque wherever `opaque` says. */
function ccittHandwriting(opaque: (x: number, y: number) => boolean) {
  const dots = [];
  for (let y = 0; y < CCITT_MASK_HEIGHT; y++) {
    for (let x = 0; x < CCITT_MASK_WIDTH; x++) if (opaque(x, y)) dots.push({ x, y, rgba: [0, 0, 0, 255] });
  }
  return handwritingImage(CCITT_MASK_WIDTH, CCITT_MASK_HEIGHT, dots);
}

test("extractHandwriting reads handwriting whose transparency is a 1-bit CCITT mask", () => {
  const handwriting = ccittHandwriting(maskOpaque);
  const pages = extractHandwriting(buildPdf([{ handwriting, ccittMask: { data: CCITT_MASK } }]));
  assert.deepEqual(decodePng(pages[0]!.png), handwriting);
});

test("extractHandwriting treats black as opaque in a CCITT mask marked BlackIs1", () => {
  const handwriting = ccittHandwriting((x, y) => !maskOpaque(x, y));
  const pages = extractHandwriting(buildPdf([{ handwriting, ccittMask: { data: CCITT_MASK, blackIs1: true } }]));
  assert.deepEqual(decodePng(pages[0]!.png), handwriting);
});

test("extractHandwriting rejects a mask inverted by a /Decode array", () => {
  const handwriting = ccittHandwriting(maskOpaque);
  const pdf = buildPdf([{ handwriting, ccittMask: { data: CCITT_MASK }, maskDecode: "[1 0]" }]);
  assert.throws(() => extractHandwriting(pdf), UnreadableMarkPdf);
});

test("extractHandwriting rejects a CCITT mask that ends before the image does", () => {
  const handwriting = handwritingImage(CCITT_MASK_WIDTH, CCITT_MASK_HEIGHT, []);
  const pdf = buildPdf([{ handwriting, ccittMask: { data: CCITT_MASK.subarray(0, 40) } }]);
  assert.throws(() => extractHandwriting(pdf), UnreadableMarkPdf);
});

test("extractHandwriting returns nothing for a PDF without handwriting", () => {
  assert.deepEqual(extractHandwriting(buildPdf([{}, {}])), []);
});

test("extractHandwriting rejects bytes that are not a PDF", () => {
  assert.throws(() => extractHandwriting(new TextEncoder().encode("<html>error</html>")), UnreadableMarkPdf);
});
