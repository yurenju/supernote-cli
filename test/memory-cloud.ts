// A stateful stand-in for Supernote Cloud's file endpoints, built on fakeCloud(),
// so write operations can be checked by what the tree looks like afterwards.

import { md5 } from "../src/hash.ts";
import { fakeCloud, rawItem, type Handler, type RecordedRequest } from "./fake-cloud.ts";

interface Node {
  id: string;
  directoryId: string;
  fileName: string;
  isFolder: boolean;
  content?: Uint8Array;
}

export interface MemoryCloudOptions {
  /** Make the S3 upload fail with this HTTP status. */
  failUpload?: number;
}

const fail = (errorMsg: string) => ({ success: false, errorCode: "E9999", errorMsg });

/**
 * Seed with paths: a trailing "/" makes a folder, anything else a file whose
 * content is its own path. Parents are created as needed.
 */
export function memoryCloud(seed: string[] = [], options: MemoryCloudOptions = {}) {
  const nodes = new Map<string, Node>();
  const uploads = new Map<string, Uint8Array>();
  let nextId = 100;

  const children = (directoryId: string) => [...nodes.values()].filter((n) => n.directoryId === directoryId);
  const pathOf = (node: Node): string => {
    const parent = nodes.get(node.directoryId);
    return `${parent ? pathOf(parent) : ""}/${node.fileName}`;
  };
  const find = (path: string) => [...nodes.values()].find((n) => pathOf(n) === path);
  /** md5 of every file content ever stored. */
  const stored = new Set<string>();
  const add = (directoryId: string, fileName: string, isFolder: boolean, content?: Uint8Array) => {
    const node = { id: String(nextId++), directoryId, fileName, isFolder, content };
    if (content) stored.add(md5(content));
    nodes.set(node.id, node);
    return node;
  };
  const ensure = (path: string, isFolder: boolean) => {
    const parts = path.split("/").filter(Boolean);
    let directoryId = "0";
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      const existing = children(directoryId).find((n) => n.fileName === part);
      const node =
        existing ?? add(directoryId, part, !last || isFolder, !last || isFolder ? undefined : enc(path));
      directoryId = node.id;
    }
  };
  const enc = (text: string) => new TextEncoder().encode(text);
  for (const path of seed) ensure(path, path.endsWith("/"));

  /** A handler for an endpoint taking directoryId and idList: every id must sit in that folder, as the real API expects. */
  const forItemsIn =
    (apply: (ids: string[], r: RecordedRequest) => void): Handler =>
    (r) => {
      const directoryId = String(r.body?.["directoryId"]);
      const ids = (r.body?.["idList"] as string[]).map(String);
      if (!ids.every((id) => nodes.get(id)?.directoryId === directoryId)) return fail("items are not in directoryId");
      apply(ids, r);
      return { success: true };
    };
  const remove = (id: string) => {
    for (const child of children(id)) remove(child.id);
    nodes.delete(id);
  };
  const copyInto = (node: Node, directoryId: string) => {
    const copy = add(directoryId, node.fileName, node.isFolder, node.content);
    for (const child of children(node.id)) copyInto(child, copy.id);
  };

  const routes: Record<string, Handler> = {
    "/file/list/query": (r) => {
      const items = children(String(r.body?.["directoryId"])).map((n) => ({
        ...rawItem(n.id, n.fileName, n.isFolder, n.directoryId),
        md5: n.content ? md5(n.content) : "",
      }));
      return { success: true, total: items.length, userFileVOList: items };
    },
    "/file/folder/add": (r) => {
      add(String(r.body?.["directoryId"]), String(r.body?.["fileName"]), true);
      return { success: true };
    },
    "/file/upload/apply": (r) => {
      // The real cloud refuses content it has ever stored, in any folder, even after a delete
      if (stored.has(String(r.body?.["md5"]))) {
        return { success: false, errorCode: "E0310", errorMsg: "There are identical md5 files already. No need to upload!" };
      }
      const innerName = `upload-${nextId++}`;
      const url = `https://s3.test/${innerName}`;
      routes[url] = (put) => {
        if (options.failUpload) return new Response("denied", { status: options.failUpload });
        uploads.set(innerName, put.bytes ?? new Uint8Array());
        return new Response("");
      };
      return { success: true, url, s3Authorization: "AWS4 sig", xamzDate: "20261022T000000Z" };
    },
    "/file/upload/finish": (r) => {
      const content = uploads.get(String(r.body?.["innerName"]));
      if (!content || md5(content) !== r.body?.["md5"]) return fail("upload not found");
      add(String(r.body?.["directoryId"]), String(r.body?.["fileName"]), false, content);
      return { success: true };
    },
    "/file/rename": (r) => {
      const node = nodes.get(String(r.body?.["id"]));
      if (!node) return fail("no such item");
      node.fileName = String(r.body?.["newName"]);
      return { success: true };
    },
    "/file/move": forItemsIn((ids, r) => {
      for (const id of ids) nodes.get(id)!.directoryId = String(r.body?.["goDirectoryId"]);
    }),
    "/file/copy": forItemsIn((ids, r) => {
      for (const id of ids) copyInto(nodes.get(id)!, String(r.body?.["goDirectoryId"]));
    }),
    "/file/delete": forItemsIn((ids) => {
      for (const id of ids) remove(id);
    }),
  };

  const cloud = fakeCloud(routes);
  return {
    ...cloud,
    /** Every path in the tree, sorted; folders end in "/". */
    paths: () => [...nodes.values()].map((n) => pathOf(n) + (n.isFolder ? "/" : "")).sort(),
    content: (path: string) => {
      const node = find(path);
      return node?.content ? new TextDecoder().decode(node.content) : undefined;
    },
    /** Requests to the given endpoint. */
    calls: (path: string) => cloud.requests.filter((r) => r.path === path),
  };
}
