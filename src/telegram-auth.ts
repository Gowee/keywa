/**
 * Session management for the web admin.
 *
 * Sessions are signed JWTs stored in KV. The JWT contains the Telegram user ID
 * and expiry time. Signed with HMAC-SHA256 using ADMIN_TOKEN as the secret.
 *
 * No external JWT library needed — just base64url + HMAC via Web Crypto API.
 */

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const COOKIE_NAME = "keywa_session";

interface SessionPayload {
  uid: number; // Telegram user ID
  iat: number; // issued at (epoch seconds)
  exp: number; // expires (epoch seconds)
}

// --- JWT helpers (minimal, no dependency) ---

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unbase64url(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

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
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return `${data}.${base64url(sig)}`;
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
  kv: KVNamespace,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    uid: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const jwt = await signJwt(payload, secret);

  // Store in KV for revocation support (key: session:{jwt_prefix}, value: "1")
  // We store a short prefix so we can revoke by deleting the KV entry
  const prefix = jwt.slice(0, 32);
  await kv.put(`session:${prefix}`, "1", {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return `${COOKIE_NAME}=${jwt}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Verify a session from the Cookie header. Returns the user ID or null. */
export async function verifySession(
  request: Request,
  secret: string,
  kv: KVNamespace,
): Promise<number | null> {
  const jwt = extractCookie(request, COOKIE_NAME);
  if (!jwt) return null;

  const payload = await verifyJwt(jwt, secret);
  if (!payload) return null;

  // Check if session was revoked
  const prefix = jwt.slice(0, 32);
  const exists = await kv.get(`session:${prefix}`);
  if (!exists) return null;

  return payload.uid;
}

/** Destroy the session (logout). Returns the Set-Cookie header to clear it. */
export async function destroySession(
  request: Request,
  secret: string,
  kv: KVNamespace,
): Promise<string> {
  const jwt = extractCookie(request, COOKIE_NAME);
  if (jwt) {
    const prefix = jwt.slice(0, 32);
    await kv.delete(`session:${prefix}`);
  }
  return `${COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// --- Helpers ---

function extractCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ?? null;
}
