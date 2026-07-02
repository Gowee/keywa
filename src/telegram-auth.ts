/**
 * Session management for the web admin.
 *
 * Sessions are signed JWTs stored in cookies only — no server-side state.
 * The JWT contains the Telegram user ID and expiry time, signed with
 * HMAC-SHA256 using ADMIN_TOKEN as the secret.
 *
 * No external JWT library needed — just base64url + HMAC via Web Crypto API.
 *
 * Revocation: change ADMIN_TOKEN. All sessions become invalid immediately.
 */

import { base64url, unbase64url } from "./crypto";

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const COOKIE_NAME = "keywa_session";

interface SessionPayload {
  uid: number; // Telegram user ID
  iat: number; // issued at (epoch seconds)
  exp: number; // expires (epoch seconds)
}

// --- JWT helpers (minimal, no dependency) ---

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signJwt(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return `${data}.${base64url(new Uint8Array(sig))}`;
}

async function verifyJwt(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    unbase64url(sig),
    new TextEncoder().encode(`${header}.${body}`),
  );
  if (!valid) return null;

  const payload: SessionPayload = JSON.parse(
    new TextDecoder().decode(unbase64url(body)),
  );
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// --- Public API ---

/** Create a session for the given Telegram user ID. Returns the Set-Cookie header value. */
export async function createSession(
  userId: number,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    uid: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const jwt = await signJwt(payload, secret);

  return `${COOKIE_NAME}=${jwt}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Verify a session from the Cookie header. Returns the user ID or null. */
export async function verifySession(
  request: Request,
  secret: string,
): Promise<number | null> {
  const jwt = extractCookie(request, COOKIE_NAME);
  if (!jwt) return null;

  const payload = await verifyJwt(jwt, secret);
  if (!payload) return null;

  return payload.uid;
}

/** Destroy the session (logout). Returns the Set-Cookie header to clear it. */
export function destroySession(): string {
  return `${COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// --- Helpers ---

function extractCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ?? null;
}
