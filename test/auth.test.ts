// Ported from rnbennett/supernote-cloud (tests/test_auth.py), Apache-2.0,
// extended with the verification-code flow and transport behaviour.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SupernoteClient } from "../src/client.ts";
import { AccessTokenRejected, AuthenticationError, IdentityVerificationRequired } from "../src/errors.ts";
import { hashPassword } from "../src/hash.ts";
import { BASE, fakeCloud, listing } from "./fake-cloud.ts";

const randomCode = () => ({ success: true, randomCode: "rc123", timestamp: 1700000000000 });

test("login signs the password and stores the token", async () => {
  const cloud = fakeCloud({
    "/official/user/query/random/code": randomCode,
    "/official/user/account/login/new": () => ({ success: true, token: "tok" }),
  });
  const client = new SupernoteClient({ baseUrl: BASE, fetch: cloud.fetch });

  assert.equal(await client.login("me@example.com", "secret"), "tok");
  assert.equal(client.accessToken, "tok");

  const login = cloud.requests.find((r) => r.path === "/official/user/account/login/new")!;
  assert.equal(login.body?.["password"], hashPassword("secret", "rc123"));
  assert.equal(login.body?.["account"], "me@example.com");
  assert.equal(login.body?.["equipment"], "1");
  assert.equal(login.headers["x-xsrf-token"], "csrf-1");
});

test("login raises IdentityVerificationRequired with the timestamp on E1760", async () => {
  const cloud = fakeCloud({
    "/official/user/query/random/code": randomCode,
    "/official/user/account/login/new": () => ({ success: false, errorCode: "E1760", errorMsg: "verify" }),
  });
  const client = new SupernoteClient({ baseUrl: BASE, fetch: cloud.fetch });

  await assert.rejects(client.login("me@example.com", "secret"), (error) => {
    assert.ok(error instanceof IdentityVerificationRequired);
    assert.equal(error.timestamp, "1700000000000");
    return true;
  });
});

test("login surfaces the server's error message", async () => {
  const cloud = fakeCloud({
    "/official/user/query/random/code": randomCode,
    "/official/user/account/login/new": () => ({ success: false, errorCode: "E0001", errorMsg: "bad password" }),
  });
  const client = new SupernoteClient({ baseUrl: BASE, fetch: cloud.fetch });

  await assert.rejects(client.login("me@example.com", "x"), (error) => {
    assert.ok(error instanceof AuthenticationError);
    assert.equal(error.message, "bad password");
    return true;
  });
});

test("verification sends a signed code request, then exchanges the session for a token", async () => {
  const cloud = fakeCloud({
    "/user/validcode/pre-auth": () => ({ success: true, token: "k0-k1-1" }),
    "/user/mail/validcode/send": () => ({ success: true, validCodeKey: "key-1" }),
    "/official/user/sms/login": () =>
      new Response(JSON.stringify({ success: true }), {
        headers: { "Set-Cookie": "SESSION=abc; Path=/; HttpOnly" },
      }),
    "/user/query/token": () => ({ success: true, token: "tok-after-code" }),
  });
  const client = new SupernoteClient({ baseUrl: BASE, fetch: cloud.fetch });

  const key = await client.sendVerificationCode("me@example.com", "1700000000000");
  assert.equal(key, "key-1");
  const send = cloud.requests.find((r) => r.path === "/user/mail/validcode/send")!;
  assert.equal(send.body?.["timestamp"], 1700000000000);
  assert.equal(typeof send.body?.["sign"], "string");

  assert.equal(await client.verifyCode("me@example.com", "123456", key, "1700000000000"), "tok-after-code");
  const query = cloud.requests.find((r) => r.path === "/user/query/token")!;
  assert.match(query.headers["cookie"] ?? "", /SESSION=abc/);
});

test("an expired verification code raises IdentityVerificationRequired so the caller can retry", async () => {
  const cloud = fakeCloud({
    "/official/user/sms/login": () => ({ success: false, errorCode: "E1756", errorMsg: "expired" }),
  });
  const client = new SupernoteClient({ baseUrl: BASE, fetch: cloud.fetch });

  await assert.rejects(client.verifyCode("me@example.com", "1", "key", "1700000000000"), IdentityVerificationRequired);
});

test("a 403 refreshes the CSRF token and retries once", async () => {
  const cloud = fakeCloud({
    "/csrf": [
      () => new Response("", { headers: { "X-XSRF-TOKEN": "csrf-old" } }),
      () => new Response("", { headers: { "X-XSRF-TOKEN": "csrf-new" } }),
    ],
    "/file/list/query": [() => new Response("", { status: 403 }), () => listing()],
  });
  const client = new SupernoteClient({ accessToken: "tok", baseUrl: BASE, fetch: cloud.fetch });

  assert.deepEqual(await client.ls(), []);
  const lists = cloud.requests.filter((r) => r.path === "/file/list/query");
  assert.equal(lists.length, 2);
  assert.equal(lists[1]!.headers["x-xsrf-token"], "csrf-new");
});

test("the access token is sent as x-access-token exactly as given", async () => {
  // Inside a Docker Sandbox this is a placeholder the proxy swaps for the real token.
  const cloud = fakeCloud({ "/file/list/query": () => listing() });
  const client = new SupernoteClient({ accessToken: "sbx-cs-placeholder", baseUrl: BASE, fetch: cloud.fetch });

  await client.ls();
  assert.equal(cloud.requests.at(-1)!.headers["x-access-token"], "sbx-cs-placeholder");
});

test("E0401 and HTTP 401 both mean the access token was rejected", async () => {
  for (const handler of [
    () => ({ success: false, errorCode: "E0401", errorMsg: "token expired" }),
    () => new Response("", { status: 401 }),
  ]) {
    const cloud = fakeCloud({ "/file/list/query": handler });
    const client = new SupernoteClient({ accessToken: "old", baseUrl: BASE, fetch: cloud.fetch });
    await assert.rejects(client.ls(), AccessTokenRejected);
  }
});
