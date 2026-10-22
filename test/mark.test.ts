import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SupernoteClient } from "../src/client.ts";
import { ApiError, FileFolderNotFound } from "../src/errors.ts";
import { BASE, fakeCloud, listing, rawItem, type RecordedRequest } from "./fake-cloud.ts";
import { buildPdf, decodePng, handwritingImage } from "./pdf-fixture.ts";

const FIRST = handwritingImage(2, 2, [{ x: 0, y: 1, rgba: [0, 0, 0, 255] }]);
const THIRD = handwritingImage(2, 2, [{ x: 1, y: 0, rgba: [80, 80, 80, 255] }]);
/** What the cloud renders for scan.pdf with its mark: handwriting on pages 1 and 3 of 3. */
const RENDERED = buildPdf([{ handwriting: FIRST }, {}, { handwriting: THIRD }]);

/** Document/ (folder 1) holds scan.pdf (20), its scan.pdf.mark (21), and orphan.pdf.mark (22) whose PDF is gone. */
function cloud() {
  return fakeCloud({
    "/file/list/query": (r: RecordedRequest) =>
      String(r.body?.["directoryId"]) === "1"
        ? listing(
            rawItem(20, "scan.pdf", false, 1),
            rawItem(21, "scan.pdf.mark", false, 1),
            rawItem(22, "orphan.pdf.mark", false, 1),
          )
        : listing(rawItem(1, "Document", true)),
    "/file/pdfwithmark/to/pdf": (r: RecordedRequest) =>
      r.body?.["id"] === "20" ? { success: true, url: "https://s3.test/rendered.pdf" } : { success: false, errorCode: "E0308" },
    "https://s3.test/rendered.pdf": () => new Response(RENDERED.slice()),
  });
}

function client(fetch: typeof globalThis.fetch) {
  return new SupernoteClient({ accessToken: "tok", baseUrl: BASE, fetch });
}

test("getPng on a .mark writes the handwriting of each annotated page, named after the mark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const fake = cloud();
  const written = await client(fake.fetch).getPng("/Document/scan.pdf.mark", dir);

  assert.deepEqual(written, [join(dir, "scan.pdf.mark_1.png"), join(dir, "scan.pdf.mark_3.png")]);
  assert.deepEqual(decodePng(await readFile(written[1]!)), THIRD);
  assert.deepEqual(fake.requests.find((r) => r.path === "/file/pdfwithmark/to/pdf")?.body, { id: "20" });
});

test("getPng on a .mark writes only the requested pages, and refuses a page without handwriting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const c = client(cloud().fetch);
  assert.deepEqual(await c.getPng("/Document/scan.pdf.mark", dir, [3]), [join(dir, "scan.pdf.mark_3.png")]);
  await assert.rejects(c.getPng("/Document/scan.pdf.mark", dir, [2]), (error) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.message, /page 2/i);
    return true;
  });
});

test("getPdf on a .mark downloads the PDF with its handwriting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const written = await client(cloud().fetch).getPdf("/Document/scan.pdf.mark", dir);
  assert.equal(written, join(dir, "scan.pdf.mark.pdf"));
  assert.deepEqual(new Uint8Array(await readFile(written)), new Uint8Array(RENDERED));
});

test("getPdf on a .mark refuses a page selection, since the cloud renders the whole PDF", async () => {
  await assert.rejects(client(cloud().fetch).getPdf("/Document/scan.pdf.mark", ".", [1]), ApiError);
});

test("a .mark whose PDF is not beside it is reported as not found", async () => {
  await assert.rejects(client(cloud().fetch).getPng("/Document/orphan.pdf.mark"), (error) => {
    assert.ok(error instanceof FileFolderNotFound);
    assert.match(error.message, /orphan\.pdf/);
    return true;
  });
});

test("a mark on anything but a PDF is refused before asking the cloud", async () => {
  const fake = fakeCloud({
    "/file/list/query": () => listing(rawItem(30, "book.epub", false), rawItem(31, "book.epub.mark", false)),
  });
  await assert.rejects(client(fake.fetch).getPng("/book.epub.mark"), /Only a PDF's mark/);
  assert.equal(fake.requests.some((r) => r.path === "/file/pdfwithmark/to/pdf"), false);
});

test("a mark in the root folder finds the PDF beside it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const fake = fakeCloud({
    "/file/list/query": () => listing(rawItem(40, "top.pdf", false), rawItem(41, "top.pdf.mark", false)),
    "/file/pdfwithmark/to/pdf": () => ({ success: true, url: "https://s3.test/rendered.pdf" }),
    "https://s3.test/rendered.pdf": () => new Response(RENDERED.slice()),
  });
  const written = await client(fake.fetch).getPng("/top.pdf.mark", dir, [1]);
  assert.deepEqual(written, [join(dir, "top.pdf.mark_1.png")]);
  assert.deepEqual(fake.requests.find((r) => r.path === "/file/pdfwithmark/to/pdf")?.body, { id: "40" });
});
