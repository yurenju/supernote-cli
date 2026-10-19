// Ported from rnbennett/supernote-cloud (tests/test_helpers.py), Apache-2.0.

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRealKey, hashPassword, md5, sha256 } from "../src/hash.ts";

test("sha256 matches the well-known vector for 'abc'", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("md5 matches the well-known vector for 'abc'", () => {
  assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

test("md5 of bytes matches md5 of the same string", () => {
  assert.equal(md5(new TextEncoder().encode("abc")), md5("abc"));
});

test("hashPassword is sha256(md5(password) + randomCode)", () => {
  assert.equal(hashPassword("secret", "rc"), sha256(md5("secret") + "rc"));
});

test("extractRealKey uses the last character as an index into the dash-split parts", () => {
  assert.equal(extractRealKey("x-y-z-2"), "z");
  assert.equal(extractRealKey("a-b-0"), "a");
});

test("extractRealKey rejects a token whose index points nowhere", () => {
  assert.throws(() => extractRealKey("a-b-9"));
});
