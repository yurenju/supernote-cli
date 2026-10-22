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

test("extractHandwriting returns nothing for a PDF without handwriting", () => {
  assert.deepEqual(extractHandwriting(buildPdf([{}, {}])), []);
});

test("extractHandwriting rejects bytes that are not a PDF", () => {
  assert.throws(() => extractHandwriting(new TextEncoder().encode("<html>error</html>")), UnreadableMarkPdf);
});
