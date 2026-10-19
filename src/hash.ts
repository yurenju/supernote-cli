// Ported to TypeScript from rnbennett/supernote-cloud (supernote_cloud/api.py),
// Apache-2.0, original work © Julian Prester. Modified by the supernote-cli authors.

import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function md5(data: string | Uint8Array): string {
  const hash = createHash("md5");
  if (typeof data === "string") hash.update(data, "utf8");
  else hash.update(data);
  return hash.digest("hex");
}

/** The password hash the login endpoint expects: sha256(md5(password) + randomCode). */
export function hashPassword(password: string, randomCode: string): string {
  return sha256(md5(password) + randomCode);
}

/** Signing key hidden in a pre-auth token: the last character indexes the dash-separated parts. */
export function extractRealKey(token: string): string {
  const index = Number(token.at(-1));
  const part = token.split("-")[index];
  if (part === undefined) throw new Error(`Malformed pre-auth token`);
  return part;
}
