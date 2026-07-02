/**
 * Shared crypto utilities for keywa.
 *
 * All identifiers use base64url encoding (no padding) for compactness.
 * Hash and nonce are 128-bit (16 bytes → 22 base64url chars).
 */

/** Encode bytes as base64url (no padding). */
export function base64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode base64url (with or without padding) to bytes. */
export function unbase64url(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Derive the Durable Object name from secretId and session.
 * SHA-256(secretId + "\0" + session) → first 16 bytes → base64url (22 chars).
 * 128-bit collision resistance.
 */
export async function doName(
  secretId: string,
  session: string,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secretId + "\0" + session),
  );
  return base64url(new Uint8Array(hash).slice(0, 16));
}

/**
 * Generate a 128-bit random nonce as base64url (22 chars).
 * Used for callback CSRF tokens.
 */
export function randomNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}
