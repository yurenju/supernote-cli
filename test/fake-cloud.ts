// A stand-in for Supernote Cloud: routes fetch() calls by path and records them.

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export type Handler = (request: RecordedRequest) => Response | string | Record<string, unknown>;

export const BASE = "https://cloud.test/api";

export function fakeCloud(routes: Record<string, Handler | Handler[]>) {
  const requests: RecordedRequest[] = [];
  const calls = new Map<string, number>();

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.origin === new URL(BASE).origin ? url.pathname.replace(/^\/api/, "") : url.href;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const request = { path, method: init.method ?? "GET", headers, body };
    requests.push(request);

    let route = routes[path];
    if (route === undefined && path === "/csrf") {
      route = () => new Response("", { headers: { "X-XSRF-TOKEN": "csrf-1" } });
    }
    if (route === undefined) throw new Error(`Unexpected request: ${path}`);
    const n = calls.get(path) ?? 0;
    calls.set(path, n + 1);
    const handler = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;

    const result = handler(request);
    if (result instanceof Response) return result;
    if (typeof result === "string") return new Response(result);
    return new Response(JSON.stringify(result));
  };

  return { fetch: fetch as typeof globalThis.fetch, requests };
}

export function rawItem(id: string | number, fileName: string, isFolder: boolean, directoryId: string | number = 0) {
  return {
    id,
    directoryId,
    fileName,
    size: isFolder ? 0 : 10,
    md5: isFolder ? "" : "abc",
    isFolder: isFolder ? "Y" : "N",
    createTime: 1700000000000,
    updateTime: 1700000000000,
  };
}

export function listing(...items: ReturnType<typeof rawItem>[]) {
  return { success: true, total: items.length, userFileVOList: items };
}
