// Ported from rnbennett/supernote-cloud (tests/test_operations.py, tests/test_walk.py),
// Apache-2.0, limited to the read-only operations and extended with pagination,
// path resolution and downloads.

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SupernoteClient, type WalkEntry } from "../src/client.ts";
import { AuthenticationError, FileFolderNotFound } from "../src/errors.ts";
import { BASE, fakeCloud, listing, rawItem, type RecordedRequest } from "./fake-cloud.ts";

const BIG_ID = "832783777540341760"; // beyond Number.MAX_SAFE_INTEGER

/** Root: Note/ (folder 1) and readme.txt. Note/: Inbox/ (folder 2) and a.note. Inbox/: b.note. */
function tree(extra: Record<string, () => unknown> = {}) {
  return fakeCloud({
    ...(extra as Record<string, () => Record<string, unknown>>),
    "/file/list/query": (r: RecordedRequest) => {
      switch (String(r.body?.["directoryId"])) {
        case "0":
          return listing(rawItem(1, "Note", true), rawItem(10, "readme.txt", false));
        case "1":
          return listing(rawItem(2, "Inbox", true, 1), rawItem(11, "a.note", false, 1));
        case "2":
          return listing(rawItem(12, "b.note", false, 2));
        default:
          return listing();
      }
    },
  });
}

function client(fetch: typeof globalThis.fetch) {
  return new SupernoteClient({ accessToken: "tok", baseUrl: BASE, fetch });
}

test("ls parses folders and files", async () => {
  const items = await client(tree().fetch).ls();
  assert.deepEqual(
    items.map((i) => [i.id, i.fileName, i.isFolder]),
    [
      ["1", "Note", true],
      ["10", "readme.txt", false],
    ],
  );
  assert.ok(items[0]!.updateTime instanceof Date);
});

test("ls keeps ids beyond 2^53 exact", async () => {
  const cloud = fakeCloud({
    "/file/list/query": () =>
      `{"success":true,"total":1,"userFileVOList":[{"id":${BIG_ID},"directoryId":0,"fileName":"x.note","size":1,"md5":"","isFolder":"N","createTime":0,"updateTime":0}]}`,
  });
  const [item] = await client(cloud.fetch).ls();
  assert.equal(item!.id, BIG_ID);
});

test("ls follows every page instead of stopping at the first 100 items", async () => {
  const page = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => rawItem(start + i, `f${start + i}.note`, false));
  const cloud = fakeCloud({
    "/file/list/query": (r: RecordedRequest) => {
      const pageNo = Number(r.body?.["pageNo"]);
      const items = pageNo === 1 ? page(0, 100) : pageNo === 2 ? page(100, 100) : page(200, 5);
      return { success: true, total: 205, userFileVOList: items };
    },
  });
  const items = await client(cloud.fetch).ls();
  assert.equal(items.length, 205);
  assert.equal(cloud.requests.filter((r) => r.path === "/file/list/query").length, 3);
});

test("ls requires an access token", async () => {
  const anon = new SupernoteClient({ baseUrl: BASE, fetch: tree().fetch });
  await assert.rejects(anon.ls(), AuthenticationError);
});

test("resolve finds nested files and folders by name, including dotted folder names", async () => {
  const c = client(tree().fetch);
  assert.equal((await c.resolve("/Note/Inbox/b.note")).id, "12");
  assert.equal((await c.resolve("Note/Inbox")).id, "2");
  assert.equal((await c.resolve("/")).id, "0");
});

test("resolve reports the missing part of the path", async () => {
  await assert.rejects(client(tree().fetch).resolve("/Note/Nope/b.note"), (error) => {
    assert.ok(error instanceof FileFolderNotFound);
    assert.match(error.message, /\/Note\/Nope/);
    return true;
  });
});

test("walk visits every folder depth-first", async () => {
  const seen: WalkEntry[] = [];
  for await (const entry of client(tree().fetch).walk()) seen.push(entry);
  assert.deepEqual(
    seen.map((e) => [e.path, e.dirs.map((d) => d.fileName), e.files.map((f) => f.fileName)]),
    [
      ["/", ["Note"], ["readme.txt"]],
      ["/Note", ["Inbox"], ["a.note"]],
      ["/Note/Inbox", [], ["b.note"]],
    ],
  );
});

test("walk from a nested folder reports full paths", async () => {
  const paths: string[] = [];
  for await (const entry of client(tree().fetch).walk("/Note/Inbox")) paths.push(entry.path);
  assert.deepEqual(paths, ["/Note/Inbox"]);
});

test("walk requires an access token", async () => {
  const anon = new SupernoteClient({ baseUrl: BASE, fetch: tree().fetch });
  await assert.rejects(anon.walk().next(), AuthenticationError);
});

function withDownloads(extra: Record<string, () => unknown>) {
  return tree({
    ...extra,
    "https://s3.test/a.note": () => "NOTE-BYTES",
    "https://s3.test/a.pdf": () => "PDF-BYTES",
    "https://s3.test/p1.png": () => "PNG-1",
    "https://s3.test/p2.png": () => "PNG-2",
  });
}

test("get downloads the original file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const cloud = withDownloads({ "/file/download/url": () => ({ success: true, url: "https://s3.test/a.note" }) });
  const written = await client(cloud.fetch).get("/Note/a.note", dir);
  assert.equal(written, join(dir, "a.note"));
  assert.equal(await readFile(written, "utf8"), "NOTE-BYTES");
});

test("getPdf names the PDF after the note", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const cloud = withDownloads({ "/file/note/to/pdf": () => ({ success: true, url: "https://s3.test/a.pdf" }) });
  const written = await client(cloud.fetch).getPdf("/Note/a.note", dir, [1]);
  assert.equal(written, join(dir, "a.pdf"));
  assert.equal(await readFile(written, "utf8"), "PDF-BYTES");
});

test("getPng writes one file per requested page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-"));
  const cloud = withDownloads({
    "/file/note/to/png": () => ({
      success: true,
      pngPageVOList: [
        { pageNo: 1, url: "https://s3.test/p1.png" },
        { pageNo: 2, url: "https://s3.test/p2.png" },
      ],
    }),
  });
  const all = await client(cloud.fetch).getPng("/Note/a.note", dir);
  assert.deepEqual(all, [join(dir, "a.note_1.png"), join(dir, "a.note_2.png")]);
  const second = await client(cloud.fetch).getPng("/Note/a.note", dir, [2]);
  assert.deepEqual(second, [join(dir, "a.note_2.png")]);
  assert.equal(await readFile(second[0]!, "utf8"), "PNG-2");
});

test("get refuses a folder", async () => {
  await assert.rejects(client(tree().fetch).get("/Note"), FileFolderNotFound);
});
