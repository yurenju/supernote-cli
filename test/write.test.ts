import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SupernoteClient } from "../src/client.ts";
import { ApiError, FileFolderExists, FileFolderNotFound, FolderNotEmpty } from "../src/errors.ts";
import { BASE } from "./fake-cloud.ts";
import { memoryCloud } from "./memory-cloud.ts";

function client(fetch: typeof globalThis.fetch) {
  return new SupernoteClient({ accessToken: "tok", baseUrl: BASE, fetch });
}

/** Write local files into a fresh temp folder and return their paths. */
async function localFiles(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "sn-put-"));
  return Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const path = join(dir, name);
      await writeFile(path, content);
      return path;
    }),
  );
}

test("put uploads local files into a cloud folder", async () => {
  const cloud = memoryCloud(["/Document/"]);
  const files = await localFiles({ "a.pdf": "PDF-A", "b.epub": "EPUB-B" });

  await client(cloud.fetch).put(files, "/Document");

  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/a.pdf", "/Document/b.epub"]);
  assert.equal(cloud.content("/Document/a.pdf"), "PDF-A");
  const s3 = cloud.requests.find((r) => r.path.startsWith("https://s3.test/"))!;
  assert.equal(s3.method, "PUT");
  assert.equal(s3.headers["authorization"], "AWS4 sig");
  assert.equal(s3.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

test("put refuses a name already in the folder and uploads nothing", async () => {
  const cloud = memoryCloud(["/Document/b.pdf"]);
  const files = await localFiles({ "a.pdf": "NEW-A", "b.pdf": "NEW-B" });

  await assert.rejects(client(cloud.fetch).put(files, "/Document"), (error) => {
    assert.ok(error instanceof FileFolderExists);
    assert.match(error.message, /\/Document\/b\.pdf/);
    return true;
  });
  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/b.pdf"]);
  assert.equal(cloud.content("/Document/b.pdf"), "/Document/b.pdf");
  assert.equal(cloud.calls("/file/upload/apply").length, 0);
});

test("put refuses two local files with the same name", async () => {
  const cloud = memoryCloud(["/Document/"]);
  const [first] = await localFiles({ "a.pdf": "ONE" });
  const [second] = await localFiles({ "a.pdf": "TWO" });

  await assert.rejects(client(cloud.fetch).put([first!, second!], "/Document"), FileFolderExists);
  assert.equal(cloud.calls("/file/upload/apply").length, 0);
});

test("put with force replaces an existing file and leaves no backup behind", async () => {
  const cloud = memoryCloud(["/Document/b.pdf", "/Document/c.pdf"]);
  const files = await localFiles({ "b.pdf": "NEW-B" });

  await client(cloud.fetch).put(files, "/Document", { force: true });

  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/b.pdf", "/Document/c.pdf"]);
  assert.equal(cloud.content("/Document/b.pdf"), "NEW-B");
});

test("put with force puts the old file back when the upload fails", async () => {
  const cloud = memoryCloud(["/Document/b.pdf"], { failUpload: 500 });
  const files = await localFiles({ "b.pdf": "NEW-B" });

  await assert.rejects(client(cloud.fetch).put(files, "/Document", { force: true }), ApiError);

  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/b.pdf"]);
  assert.equal(cloud.content("/Document/b.pdf"), "/Document/b.pdf");
});

test("put with force never replaces a folder", async () => {
  const cloud = memoryCloud(["/Document/b.pdf/inside.txt"]);
  const files = await localFiles({ "b.pdf": "NEW-B" });

  await assert.rejects(client(cloud.fetch).put(files, "/Document", { force: true }), FileFolderExists);
  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/b.pdf/", "/Document/b.pdf/inside.txt"]);
});

test("put refuses a local folder before uploading anything", async () => {
  const cloud = memoryCloud(["/Document/"]);
  const [file] = await localFiles({ "a.pdf": "A" });
  const folder = await mkdtemp(join(tmpdir(), "sn-dir-"));

  await assert.rejects(client(cloud.fetch).put([file!, folder], "/Document"), /Not a file/);
  assert.equal(cloud.calls("/file/upload/apply").length, 0);
});

test("mkdir creates a folder inside an existing one", async () => {
  const cloud = memoryCloud(["/Document/"]);
  await client(cloud.fetch).mkdir("/Document/2026");
  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/2026/"]);
});

test("mkdir refuses an existing name and a missing parent", async () => {
  const cloud = memoryCloud(["/Document/2026/"]);
  await assert.rejects(client(cloud.fetch).mkdir("/Document/2026"), FileFolderExists);
  await assert.rejects(client(cloud.fetch).mkdir("/Document/2027/Q4"), FileFolderNotFound);
  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/2026/"]);
});

test("mkdir with parents creates every missing folder and accepts one that exists", async () => {
  const cloud = memoryCloud(["/Document/"]);
  await client(cloud.fetch).mkdir("/Document/2026/Q4", { parents: true });
  await client(cloud.fetch).mkdir("/Document/2026", { parents: true });
  assert.deepEqual(cloud.paths(), ["/Document/", "/Document/2026/", "/Document/2026/Q4/"]);
});

test("mkdir with parents still refuses a file in the way", async () => {
  const cloud = memoryCloud(["/Document/2026"]);
  await assert.rejects(client(cloud.fetch).mkdir("/Document/2026/Q4", { parents: true }), FileFolderExists);
});

test("rename changes the name in place", async () => {
  const cloud = memoryCloud(["/Note/a.note"]);
  await client(cloud.fetch).rename("/Note/a.note", "b.note");
  assert.deepEqual(cloud.paths(), ["/Note/", "/Note/b.note"]);
});

test("rename refuses a taken name and a name with a slash", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Note/b.note"]);
  await assert.rejects(client(cloud.fetch).rename("/Note/a.note", "b.note"), FileFolderExists);
  await assert.rejects(client(cloud.fetch).rename("/Note/a.note", "x/c.note"), /slash/);
  assert.deepEqual(cloud.paths(), ["/Note/", "/Note/a.note", "/Note/b.note"]);
});

test("mv moves items from different folders into one folder", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Note/Inbox/b.note", "/Archive/"]);
  await client(cloud.fetch).mv(["/Note/a.note", "/Note/Inbox/b.note", "/Note/Inbox"], "/Archive");
  assert.deepEqual(cloud.paths(), ["/Archive/", "/Archive/Inbox/", "/Archive/a.note", "/Archive/b.note", "/Note/"]);
});

test("mv refuses a taken name, a file as target, and a folder into itself, moving nothing", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Note/b.note", "/Archive/b.note"]);
  const before = cloud.paths();
  await assert.rejects(client(cloud.fetch).mv(["/Note/a.note", "/Note/b.note"], "/Archive"), FileFolderExists);
  await assert.rejects(client(cloud.fetch).mv(["/Note/a.note"], "/Archive/b.note"), FileFolderNotFound);
  await assert.rejects(client(cloud.fetch).mv(["/Note"], "/Note"), /into itself/);
  assert.deepEqual(cloud.paths(), before);
  assert.equal(cloud.calls("/file/move").length, 0);
});

test("cp copies a folder with its contents and keeps the original", async () => {
  const cloud = memoryCloud(["/Note/Inbox/b.note", "/Archive/"]);
  await client(cloud.fetch).cp(["/Note/Inbox"], "/Archive");
  assert.deepEqual(cloud.paths(), [
    "/Archive/",
    "/Archive/Inbox/",
    "/Archive/Inbox/b.note",
    "/Note/",
    "/Note/Inbox/",
    "/Note/Inbox/b.note",
  ]);
});

test("cp refuses a taken name", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Archive/a.note"]);
  await assert.rejects(client(cloud.fetch).cp(["/Note/a.note"], "/Archive"), FileFolderExists);
  assert.equal(cloud.calls("/file/copy").length, 0);
});

test("rm deletes files from different folders and empty folders", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Note/Inbox/b.note", "/Empty/"]);
  await client(cloud.fetch).rm(["/Note/a.note", "/Note/Inbox/b.note", "/Empty"]);
  assert.deepEqual(cloud.paths(), ["/Note/", "/Note/Inbox/"]);
});

test("rm refuses a non-empty folder unless recursive, deleting nothing", async () => {
  const cloud = memoryCloud(["/Note/a.note", "/Old/x.note"]);
  await assert.rejects(client(cloud.fetch).rm(["/Note/a.note", "/Old"]), FolderNotEmpty);
  assert.deepEqual(cloud.paths(), ["/Note/", "/Note/a.note", "/Old/", "/Old/x.note"]);

  await client(cloud.fetch).rm(["/Old"], { recursive: true });
  assert.deepEqual(cloud.paths(), ["/Note/", "/Note/a.note"]);
});

test("rm refuses the root", async () => {
  const cloud = memoryCloud(["/Note/"]);
  await assert.rejects(client(cloud.fetch).rm(["/"], { recursive: true }), /root/);
});

test("mkdir with parents accepts the root", async () => {
  const cloud = memoryCloud(["/Note/"]);
  await client(cloud.fetch).mkdir("/", { parents: true });
  assert.deepEqual(cloud.paths(), ["/Note/"]);
});

test("rm deletes each item once, skipping items inside a folder it also deletes", async () => {
  const cloud = memoryCloud(["/A/b.note", "/C/d.note", "/keep.note"]);
  await client(cloud.fetch).rm(["/A", "/A/b.note", "/C/d.note", "/C/d.note"], { recursive: true });
  assert.deepEqual(cloud.paths(), ["/C/", "/keep.note"]);
});
