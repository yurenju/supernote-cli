// Ported to TypeScript from rnbennett/supernote-cloud (supernote_cloud/api.py,
// endpoints.py, models.py), Apache-2.0, original work © Julian Prester.
// Modified by the supernote-cli authors: string ids, paginated listing, path
// resolution by name, and guarded writes (no silent overwrite, grouping by
// folder, recursive delete only on request). See NOTICE.

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import {
  AccessTokenRejected,
  ApiError,
  AuthenticationError,
  FileFolderExists,
  FileFolderNotFound,
  FolderNotEmpty,
  IdentityVerificationRequired,
} from "./errors.ts";
import { extractRealKey, hashPassword, md5, sha256 } from "./hash.ts";

export const BASE_URL = "https://cloud.supernote.com/api";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_SIZE = 100;

const endpoints = {
  csrf: "/csrf",
  randomCode: "/official/user/query/random/code",
  login: "/official/user/account/login/new",
  preAuth: "/user/validcode/pre-auth",
  sendEmailCode: "/user/mail/validcode/send",
  codeLogin: "/official/user/sms/login",
  queryToken: "/user/query/token",
  list: "/file/list/query",
  downloadUrl: "/file/download/url",
  noteToPdf: "/file/note/to/pdf",
  noteToPng: "/file/note/to/png",
  mkdir: "/file/folder/add",
  uploadApply: "/file/upload/apply",
  uploadFinish: "/file/upload/finish",
  rename: "/file/rename",
  move: "/file/move",
  copy: "/file/copy",
  delete: "/file/delete",
} as const;

/** Error codes meaning the access token is missing, expired or wrong. */
const TOKEN_REJECTED_CODES = new Set(["E0401"]);
/** Error codes meaning the emailed verification code expired. */
const CODE_EXPIRED_CODES = new Set(["E1756", "E0101", "E1760"]);

export interface CloudItem {
  /** Kept as a string: ids exceed Number.MAX_SAFE_INTEGER. */
  id: string;
  directoryId: string;
  fileName: string;
  size: number;
  md5: string;
  isFolder: boolean;
  createTime: Date;
  updateTime: Date;
}

export const ROOT: CloudItem = {
  id: "0",
  directoryId: "",
  fileName: "/",
  size: 0,
  md5: "",
  isFolder: true,
  createTime: new Date(0),
  updateTime: new Date(0),
};

export interface WalkEntry {
  path: string;
  dirs: CloudItem[];
  files: CloudItem[];
}

export interface ClientOptions {
  accessToken?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface BaseResponse {
  success?: boolean;
  errorCode?: string;
  errorMsg?: string;
  [key: string]: unknown;
}

interface RawItem {
  id: string | number;
  directoryId: string | number;
  fileName: string;
  size: number;
  md5: string;
  isFolder: "Y" | "N";
  createTime: number;
  updateTime: number;
}

/** JSON.parse that keeps integers beyond 2^53 as their exact source text. */
function parseJson(text: string): BaseResponse {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source
      ? context.source
      : value,
  );
}

function toItem(raw: RawItem): CloudItem {
  return {
    id: String(raw.id),
    directoryId: String(raw.directoryId),
    fileName: raw.fileName,
    size: raw.size,
    md5: raw.md5,
    isFolder: raw.isFolder === "Y",
    createTime: new Date(raw.createTime),
    updateTime: new Date(raw.updateTime),
  };
}

/** "/" plus the path's parts, so "Note/" and "/Note" print the same. */
function normalize(path: string): string {
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

/** How to name an item in a message: its path when given one, else its name. */
function display(item: string | CloudItem): string {
  return typeof item === "string" ? normalize(item) : item.fileName;
}

/** A display path for a name inside a folder given by path or item. */
function childPath(folder: string | CloudItem, name: string): string {
  const base = typeof folder === "string" ? normalize(folder) : folder.fileName;
  return `${base.replace(/\/$/, "")}/${name}`;
}

function expectSuccess(data: BaseResponse, fallback: string): void {
  if (!data.success) throw new ApiError(data.errorMsg || fallback, data.errorCode);
}

export class SupernoteClient {
  #accessToken: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  #csrfToken: string | undefined;
  readonly #cookies = new Map<string, string>();

  constructor(options: ClientOptions = {}) {
    this.#accessToken = options.accessToken;
    this.#baseUrl = options.baseUrl ?? BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get accessToken(): string | undefined {
    return this.#accessToken;
  }

  // --- transport -----------------------------------------------------------

  #storeCookies(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  #cookieHeader(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async #refreshCsrfToken(): Promise<void> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    const cookie = this.#cookieHeader();
    if (cookie) headers["Cookie"] = cookie;
    const response = await this.#fetch(`${this.#baseUrl}${endpoints.csrf}`, { headers });
    if (!response.ok) throw new ApiError(`Failed to fetch CSRF token: HTTP ${response.status}`);
    this.#storeCookies(response);
    this.#csrfToken = response.headers.get("X-XSRF-TOKEN") ?? undefined;
  }

  #post(endpoint: string, payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.#csrfToken) headers["X-XSRF-TOKEN"] = this.#csrfToken;
    if (this.#accessToken) headers["x-access-token"] = this.#accessToken;
    const cookie = this.#cookieHeader();
    if (cookie) headers["Cookie"] = cookie;
    return this.#fetch(`${this.#baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  async #call(endpoint: string, payload: unknown): Promise<BaseResponse> {
    if (this.#csrfToken === undefined) await this.#refreshCsrfToken();
    let response = await this.#post(endpoint, payload);
    // CSRF token expired mid-session: refresh and retry once
    if (response.status === 403) {
      await this.#refreshCsrfToken();
      response = await this.#post(endpoint, payload);
    }
    this.#storeCookies(response);
    // Server may rotate the CSRF token (e.g. after verification): keep in sync
    const rotated = this.#cookies.get("XSRF-TOKEN");
    if (rotated) this.#csrfToken = rotated;

    if (response.status === 401) throw new AccessTokenRejected();
    if (!response.ok) throw new ApiError(`HTTP ${response.status} from ${endpoint}`);
    const data = parseJson(await response.text());
    if (data.success === false && data.errorCode && TOKEN_REJECTED_CODES.has(data.errorCode)) {
      throw new AccessTokenRejected(data.errorMsg || undefined, data.errorCode);
    }
    return data;
  }

  #requireToken(): void {
    if (!this.#accessToken) throw new AuthenticationError("Must be authenticated: no access token");
  }

  async #download(url: string): Promise<Uint8Array> {
    const response = await this.#fetch(url);
    if (!response.ok) throw new ApiError(`Download failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  // --- login ---------------------------------------------------------------

  async #randomCode(email: string): Promise<{ randomCode: string; timestamp: string }> {
    const data = await this.#call(endpoints.randomCode, { countryCode: "1", account: email });
    if (!data.success) throw new ApiError("Failed to get random code", data.errorCode);
    return { randomCode: String(data["randomCode"]), timestamp: String(data["timestamp"]) };
  }

  /**
   * Log in with email and password and return the access token.
   * Throws IdentityVerificationRequired when the server wants an emailed code;
   * continue with sendVerificationCode() and verifyCode().
   */
  async login(email: string, password: string): Promise<string> {
    const { randomCode, timestamp } = await this.#randomCode(email);
    const data = await this.#call(endpoints.login, {
      countryCode: 1,
      account: email,
      password: hashPassword(password, randomCode),
      browser: "Chrome107",
      equipment: "1",
      loginMethod: "1",
      timestamp,
      language: "en",
    });
    if (!data.success) {
      if (data.errorCode === "E1760") throw new IdentityVerificationRequired(timestamp);
      throw new AuthenticationError(data.errorMsg || "Login failed", data.errorCode);
    }
    this.#accessToken = String(data["token"]);
    return this.#accessToken;
  }

  /** Email a verification code to the account owner. Returns the key verifyCode() needs. */
  async sendVerificationCode(email: string, timestamp: string): Promise<string> {
    const pre = await this.#call(endpoints.preAuth, { account: email });
    if (!pre.success) throw new AuthenticationError(`Pre-auth failed: ${pre.errorMsg ?? ""}`, pre.errorCode);
    const token = String(pre["token"]);
    const sign = sha256(email + extractRealKey(token));
    const data = await this.#call(endpoints.sendEmailCode, {
      email,
      timestamp: Number(timestamp),
      token,
      sign,
    });
    if (!data.success) {
      throw new AuthenticationError(`Failed to send verification code: ${data.errorMsg ?? ""}`, data.errorCode);
    }
    return String(data["validCodeKey"] ?? "");
  }

  /**
   * Submit the emailed code and return the access token.
   * Throws IdentityVerificationRequired when the code expired, so the caller can start over.
   */
  async verifyCode(email: string, code: string, validCodeKey: string, timestamp: string): Promise<string> {
    const data = await this.#call(endpoints.codeLogin, {
      email,
      validCode: code,
      validCodeKey,
      timestamp: Number(timestamp),
      browser: "Chrome107",
      equipment: "4",
    });
    if (!data.success) {
      if (data.errorCode && CODE_EXPIRED_CODES.has(data.errorCode)) {
        throw new IdentityVerificationRequired(timestamp, "Verification code expired");
      }
      throw new AuthenticationError(`Verification failed: ${data.errorMsg ?? ""}`, data.errorCode);
    }
    // The code login established a cookie session: exchange it for the access token
    const tokenData = await this.#call(endpoints.queryToken, {});
    const token = tokenData["token"];
    if (!token) throw new AuthenticationError("Verification succeeded but no access token was returned");
    this.#accessToken = String(token);
    return this.#accessToken;
  }

  // --- reading -------------------------------------------------------------

  /** Find a file or folder by its path, e.g. "/Note/Inbox/foo.note". "/" is the root. */
  async resolve(path: string): Promise<CloudItem> {
    const parts = path.split("/").filter(Boolean);
    let current = ROOT;
    for (const [i, part] of parts.entries()) {
      if (!current.isFolder) throw new FileFolderNotFound(`Not a folder: /${parts.slice(0, i).join("/")}`);
      const found = (await this.ls(current)).find((item) => item.fileName === part);
      if (!found) throw new FileFolderNotFound(`Not found: /${parts.slice(0, i + 1).join("/")}`);
      current = found;
    }
    return current;
  }

  async #toItem(item: string | CloudItem | undefined): Promise<CloudItem> {
    if (item === undefined) return ROOT;
    return typeof item === "string" ? this.resolve(item) : item;
  }

  /** List a folder (root by default), following every page. */
  async ls(directory?: string | CloudItem): Promise<CloudItem[]> {
    this.#requireToken();
    const dir = await this.#toItem(directory);
    if (!dir.isFolder) throw new FileFolderNotFound(`Not a folder: ${dir.fileName}`);

    const items: CloudItem[] = [];
    for (let pageNo = 1; ; pageNo++) {
      const data = await this.#call(endpoints.list, {
        directoryId: dir.id === ROOT.id ? 0 : dir.id,
        pageNo,
        pageSize: PAGE_SIZE,
        order: "time",
        sequence: "desc",
      });
      expectSuccess(data, "Failed to list folder");
      const page = (data["userFileVOList"] as RawItem[] | undefined) ?? [];
      items.push(...page.map(toItem));
      const total = data["total"];
      if (page.length < PAGE_SIZE || (typeof total === "number" && items.length >= total)) break;
    }
    return items;
  }

  /** Walk the folder tree depth-first, like os.walk(). */
  async *walk(directory?: string | CloudItem): AsyncGenerator<WalkEntry> {
    this.#requireToken();
    const start = await this.#toItem(directory);
    const startPath = typeof directory === "string" ? `/${directory.split("/").filter(Boolean).join("/")}` : "/";

    const visit = async function* (client: SupernoteClient, dir: CloudItem, path: string): AsyncGenerator<WalkEntry> {
      const items = await client.ls(dir);
      const dirs = items.filter((item) => item.isFolder);
      const files = items.filter((item) => !item.isFolder);
      yield { path, dirs, files };
      for (const child of dirs) {
        yield* visit(client, child, `${path.replace(/\/$/, "")}/${child.fileName}`);
      }
    };
    yield* visit(this, start, startPath);
  }

  async #fileItem(item: string | CloudItem): Promise<CloudItem> {
    this.#requireToken();
    const file = await this.#toItem(item);
    if (file.isFolder) throw new FileFolderNotFound(`Not a file: ${file.fileName}`);
    return file;
  }

  /** Download a file as-is. Returns the path written. */
  async get(item: string | CloudItem, outDir = "."): Promise<string> {
    const file = await this.#fileItem(item);
    const data = await this.#call(endpoints.downloadUrl, { id: file.id, type: 0 });
    expectSuccess(data, "Failed to get download URL");
    const target = join(outDir, file.fileName);
    await writeFile(target, await this.#download(String(data["url"])));
    return target;
  }

  /** Have the server render a .note as PDF and download it. Empty pages means all pages. */
  async getPdf(item: string | CloudItem, outDir = ".", pages: number[] = []): Promise<string> {
    const file = await this.#fileItem(item);
    const data = await this.#call(endpoints.noteToPdf, { id: file.id, pageNoList: pages });
    expectSuccess(data, "Failed to convert note to PDF");
    const target = join(outDir, `${file.fileName.replace(/\.note$/i, "")}.pdf`);
    await writeFile(target, await this.#download(String(data["url"])));
    return target;
  }

  /** Have the server render a .note as one PNG per page and download them. Empty pages means all pages. */
  async getPng(item: string | CloudItem, outDir = ".", pages: number[] = []): Promise<string[]> {
    const file = await this.#fileItem(item);
    const data = await this.#call(endpoints.noteToPng, { id: file.id });
    expectSuccess(data, "Failed to convert note to PNG");
    const list = (data["pngPageVOList"] as { pageNo: number; url: string }[] | undefined) ?? [];
    const urls = new Map(list.map((png) => [png.pageNo, png.url]));
    const wanted = pages.length > 0 ? pages : [...urls.keys()];

    const written: string[] = [];
    for (const page of wanted) {
      const url = urls.get(page);
      if (!url) throw new ApiError(`Page ${page} not found in ${file.fileName}`);
      const target = join(outDir, `${file.fileName}_${page}.png`);
      await writeFile(target, await this.#download(url));
      written.push(target);
    }
    return written;
  }

  // --- writing -------------------------------------------------------------

  async #folderItem(item: string | CloudItem): Promise<CloudItem> {
    this.#requireToken();
    const folder = await this.#toItem(item);
    if (!folder.isFolder) throw new FileFolderNotFound(`Not a folder: ${folder.fileName}`);
    return folder;
  }

  /** The id the write endpoints expect for a folder: the root is 0. */
  #directoryId(folder: CloudItem): string | number {
    return folder.id === ROOT.id ? 0 : folder.id;
  }

  /**
   * Upload local files into a cloud folder, keeping their names. Returns the names uploaded.
   * A name the folder already has is refused, unless force is set and it is a file: then the
   * old file is renamed aside, the new one uploaded, and the old one deleted, or renamed back
   * if the upload fails.
   */
  async put(localPaths: string[], folder: string | CloudItem, options: { force?: boolean } = {}): Promise<string[]> {
    for (const localPath of localPaths) {
      if (!(await stat(localPath)).isFile()) throw new FileFolderNotFound(`Not a file: ${localPath}`);
    }
    const target = await this.#folderItem(folder);
    const names = localPaths.map((localPath) => basename(localPath));
    const repeated = names.find((name, i) => names.indexOf(name) !== i);
    if (repeated !== undefined) {
      throw new FileFolderExists(`Two files would both become ${childPath(folder, repeated)}`);
    }

    const existing = new Map((await this.ls(target)).map((item) => [item.fileName, item]));
    const replacing = new Map<string, CloudItem>();
    for (const name of names) {
      const item = existing.get(name);
      if (!item) continue;
      if (!options.force || item.isFolder) throw new FileFolderExists(`Already exists: ${childPath(folder, name)}`);
      replacing.set(name, item);
    }

    for (const localPath of localPaths) {
      const old = replacing.get(basename(localPath));
      if (!old) {
        await this.#upload(localPath, target);
        continue;
      }
      const backup = `${old.fileName}.bak-${Date.now()}`;
      await this.#rename(old, backup);
      try {
        await this.#upload(localPath, target);
      } catch (error) {
        await this.#rename(old, old.fileName).catch(() => {
          throw new ApiError(`Upload of ${old.fileName} failed, and the old file is left as ${backup}`);
        });
        throw error;
      }
      await this.#delete(target, [old]).catch((error: unknown) => {
        throw new ApiError(`Uploaded ${old.fileName}, but could not delete the old copy ${backup}: ${String(error)}`);
      });
    }
    return names;
  }

  async #rename(item: CloudItem, newName: string): Promise<void> {
    const data = await this.#call(endpoints.rename, { id: item.id, newName });
    expectSuccess(data, `Failed to rename ${item.fileName}`);
  }

  /** Delete items that all sit in the given folder. */
  async #delete(folder: CloudItem, items: CloudItem[]): Promise<void> {
    const data = await this.#call(endpoints.delete, {
      directoryId: this.#directoryId(folder),
      idList: items.map((item) => item.id),
    });
    expectSuccess(data, "Failed to delete");
  }

  /**
   * Create a folder. Its parent must exist and its name must be free, unless parents is set:
   * then missing parents are created too and an existing folder is accepted.
   */
  async mkdir(path: string, options: { parents?: boolean } = {}): Promise<void> {
    this.#requireToken();
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) {
      if (options.parents) return;
      throw new FileFolderExists("Already exists: /");
    }
    let current = ROOT;
    for (const [i, part] of parts.entries()) {
      const here = `/${parts.slice(0, i + 1).join("/")}`;
      const last = i === parts.length - 1;
      let found = (await this.ls(current)).find((item) => item.fileName === part);
      if (found && (!found.isFolder || (last && !options.parents))) throw new FileFolderExists(`Already exists: ${here}`);
      if (!found) {
        if (!last && !options.parents) throw new FileFolderNotFound(`Not found: ${here}`);
        const data = await this.#call(endpoints.mkdir, { directoryId: this.#directoryId(current), fileName: part });
        expectSuccess(data, `Failed to create ${here}`);
        found = (await this.ls(current)).find((item) => item.fileName === part && item.isFolder);
        if (!found) throw new ApiError(`Created ${here} but cannot find it`);
      }
      current = found;
    }
  }

  /** Rename a file or folder in place. */
  async rename(item: string | CloudItem, newName: string): Promise<void> {
    this.#requireToken();
    if (newName.includes("/")) throw new ApiError(`A new name cannot contain a slash: ${newName}`);
    const target = await this.#movable(item);
    if ((await this.ls(this.#parentOf(target))).some((sibling) => sibling.fileName === newName)) {
      const folder = typeof item === "string" ? posix.dirname(normalize(item)) : "";
      throw new FileFolderExists(`Already exists: ${childPath(folder, newName)}`);
    }
    await this.#rename(target, newName);
  }

  /** Move files and folders, from any folders, into one folder. */
  async mv(items: (string | CloudItem)[], folder: string | CloudItem): Promise<void> {
    await this.#transfer(endpoints.move, "move", items, folder);
  }

  /** Copy files and folders, folders with their contents, into one folder. */
  async cp(items: (string | CloudItem)[], folder: string | CloudItem): Promise<void> {
    await this.#transfer(endpoints.copy, "copy", items, folder);
  }

  /** Delete files and folders. A folder with contents needs recursive. */
  async rm(items: (string | CloudItem)[], options: { recursive?: boolean } = {}): Promise<void> {
    this.#requireToken();
    // Deleting a folder deletes what is inside it: drop paths below another one, and repeats
    const paths = items.filter((item): item is string => typeof item === "string").map(normalize);
    const wanted = items.filter(
      (item) => typeof item !== "string" || !paths.some((path) => normalize(item).startsWith(`${path}/`)),
    );
    const targets: CloudItem[] = [];
    for (const item of wanted) {
      const target = await this.#movable(item);
      if (targets.some((seen) => seen.id === target.id)) continue;
      if (!options.recursive && target.isFolder && (await this.ls(target)).length > 0) {
        throw new FolderNotEmpty(`Folder is not empty: ${display(item)}`);
      }
      targets.push(target);
    }
    for (const group of this.#byFolder(targets)) await this.#delete(this.#parentOf(group[0]!), group);
  }

  async #transfer(
    endpoint: string,
    verb: string,
    items: (string | CloudItem)[],
    folder: string | CloudItem,
  ): Promise<void> {
    const target = await this.#folderItem(folder);
    const sources: CloudItem[] = [];
    for (const [i, item] of items.entries()) {
      const source = await this.#movable(item);
      const into = typeof folder === "string" ? normalize(folder) : undefined;
      const from = display(item);
      if (source.id === target.id || (into && typeof item === "string" && into.startsWith(`${from}/`))) {
        throw new ApiError(`Cannot ${verb} ${from} into itself`);
      }
      sources[i] = source;
    }
    const taken = new Set((await this.ls(target)).map((item) => item.fileName));
    for (const source of sources) {
      if (taken.has(source.fileName)) throw new FileFolderExists(`Already exists: ${childPath(folder, source.fileName)}`);
      taken.add(source.fileName);
    }
    for (const group of this.#byFolder(sources)) {
      const data = await this.#call(endpoint, {
        directoryId: this.#directoryId(this.#parentOf(group[0]!)),
        goDirectoryId: this.#directoryId(target),
        idList: group.map((item) => item.id),
      });
      expectSuccess(data, `Failed to ${verb}`);
    }
  }

  /** Resolve an item that may be renamed, moved or deleted: anything but the root. */
  async #movable(item: string | CloudItem): Promise<CloudItem> {
    const resolved = await this.#toItem(item);
    if (resolved.id === ROOT.id) throw new ApiError("The root folder cannot be changed");
    return resolved;
  }

  /** The folder an item sits in, as far as the write endpoints need it: just its id. */
  #parentOf(item: CloudItem): CloudItem {
    return item.directoryId === ROOT.id ? ROOT : { ...ROOT, id: item.directoryId, fileName: "" };
  }

  /** Items grouped by the folder they sit in: the write endpoints take one folder per call. */
  #byFolder(items: CloudItem[]): CloudItem[][] {
    const groups = new Map<string, CloudItem[]>();
    for (const item of items) groups.set(item.directoryId, [...(groups.get(item.directoryId) ?? []), item]);
    return [...groups.values()];
  }

  async #upload(localPath: string, folder: CloudItem): Promise<void> {
    const content = await readFile(localPath);
    const fileName = basename(localPath);
    const directoryId = this.#directoryId(folder);
    const hash = md5(content);

    const apply = await this.#call(endpoints.uploadApply, { directoryId, fileName, md5: hash, size: content.length });
    expectSuccess(apply, `Failed to start upload of ${fileName}`);
    const url = String(apply["url"]);
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: {
        Authorization: String(apply["s3Authorization"]),
        "x-amz-date": String(apply["xamzDate"]),
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      },
      body: new Uint8Array(content),
    });
    if (!response.ok) throw new ApiError(`Upload of ${fileName} failed: HTTP ${response.status}`);

    const finish = await this.#call(endpoints.uploadFinish, {
      directoryId,
      fileName,
      fileSize: content.length,
      innerName: basename(new URL(url).pathname),
      md5: hash,
    });
    expectSuccess(finish, `Failed to finish upload of ${fileName}`);
  }
}
