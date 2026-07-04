import { Hono } from "hono";
import { waitUntil } from "cloudflare:workers";
import type { Env, SecretRow } from "./types";
import { DEFAULT_SESSION, getTimeoutMs } from "./types";
import {
  parseCallbackData,
  answerCallbackQuery,
  updateApprovalMessage,
  registerWebhook,
  formatTelegramUser,
} from "./telegram";
import { createSession, verifySession, destroySession } from "./telegram-auth";
import { loginPage, dashboardPage } from "./admin-ui";
import { KeySessionDO } from "./key-session-do";
import { doName } from "./crypto";
import {
  parseClientIp,
  parseCidrs,
  ipMatchesCidrs,
  normalizeCidrs,
} from "./cidr";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reserved secretId used for web admin login approval. */
const LOGIN_SECRET_ID = "__login__";

/** Reject secretId or session containing null byte (delimiter for DO name hashing). */
function rejectNullByte(value: string, label: string): string | null {
  if (value.includes("\0")) return `${label} must not contain null byte`;
  return null;
}

/** Initialize the D1 secrets table. Safe to call multiple times. */
async function initDB(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL, token TEXT NOT NULL, cidrs TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)",
    )
    .run();
}

// ---------------------------------------------------------------------------
// Secret retrieval — long-poll until approved
// ---------------------------------------------------------------------------

app.get("/secret/:secretId", (c) => handleSecretRequest(c));

async function handleSecretRequest(
  c: Parameters<Parameters<typeof app.get>[1]>[0],
) {
  const secretId = c.req.param("secretId");
  const session = c.req.query("session") || DEFAULT_SESSION;
  const secretToken =
    c.req.query("token") ?? extractBearerToken(c.req.header("Authorization"));
  const rawIp =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For") ??
    "unknown";
  const clientIp = parseClientIp(rawIp) ?? rawIp;

  if (!secretId) return c.text("secretId required", 400);
  if (secretId === LOGIN_SECRET_ID)
    return c.text("secretId is reserved", 400);
  if (secretId.length > LIMITS.secretId)
    return c.text(`secretId too long (max ${LIMITS.secretId})`, 400);
  if (session.length > LIMITS.session)
    return c.text(`session too long (max ${LIMITS.session})`, 400);
  const nullErr =
    rejectNullByte(secretId, "secretId") || rejectNullByte(session, "session");
  if (nullErr) return c.text(nullErr, 400);

  // Validate secret exists and check auth (CIDR + token)
  const row = await c.env.DB.prepare(
    "SELECT secret, token, cidrs FROM secrets WHERE id = ?",
  )
    .bind(secretId)
    .first<SecretRow>();
  if (!row) return c.text("Secret not found", 404);

  // CIDR check: skip if no CIDRs configured
  if (row.cidrs) {
    if (clientIp === "unknown")
      return c.text("Unable to determine client IP", 500);
    const parsed = parseCidrs(row.cidrs);
    if (!parsed.ok) return c.text(parsed.error, 500);
    if (!ipMatchesCidrs(clientIp, parsed.cidrs))
      return c.text("IP not allowed", 403);
  }

  // Token check: skip if no token configured; require if set.
  // Note: 401 (not 404) when token is required but missing — this intentionally
  // leaks that the secret exists, since the Telegram approval flow is the real gate.
  if (row.token) {
    if (!secretToken)
      return c.text("token required (query param or Bearer header)", 401);
    if (row.token !== secretToken) return c.text("Invalid token", 403);
  }

  // Rate limit: 10 requests per 60s per secretId+IP
  if (c.env.KEY_REQUEST_RATE_LIMIT) {
    const { success } = await c.env.KEY_REQUEST_RATE_LIMIT.limit({
      key: secretId + ":" + clientIp,
    });
    if (!success) return c.text("Too many requests", 429);
  }

  // DO stores the secret at init time so the approved value is the one
  // that existed when the request was triggered, even if D1 changes later.
  const name = await doName(secretId, session);
  const doId = c.env.KEY_SESSION_DO.idFromName(name);
  const stub = c.env.KEY_SESSION_DO.get(
    doId,
  ) as DurableObjectStub<KeySessionDO>;

  try {
    await stub.init(secretId, session, clientIp, row.secret);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already pending"))
      return c.text("Request already pending", 409);
    throw err;
  }

  // Cancel the pending wait if the client disconnects so the DO's
  // resolver doesn't become stale. waitUntil() is required because the
  // abort handler fires as the Worker is being torn down — without it
  // the cancelWait() RPC would be dropped and subsequent requests to
  // the same session would keep hitting 409 until the alarm cleans up.
  const onAbort = () => { waitUntil(stub.cancelWait()); };
  c.req.raw.signal.addEventListener("abort", onAbort);

  const approval = await stub.wait();

  switch (approval.status) {
    case "approved": {
      // Secret is captured at init time and stored in the DO. If missing,
      // the DO state is corrupted — treat as a server error.
      if (!approval.secret) return c.text("Secret unavailable", 500);
      return c.text(approval.secret);
    }
    case "denied":
      return c.text("Denied", 403);
    case "expired":
      return c.text("Request expired", 504);
    default:
      return c.text("Unknown status", 500);
  }
}

// ---------------------------------------------------------------------------
// Telegram webhook — receives callback_query
// ---------------------------------------------------------------------------

app.post("/telegram/webhook", async (c) => {
  if (c.env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
      return c.text("Unauthorized", 401);
    }
  }

  const update = await c.req.json<{
    callback_query?: {
      id: string;
      data?: string;
      message?: { chat: { id: number }; message_id: number };
      from?: {
        id: number;
        username?: string;
        first_name?: string;
        last_name?: string;
      };
    };
  }>();

  const cb = update.callback_query;
  if (!cb?.data) return c.json({ ok: true });

  const parsed = parseCallbackData(cb.data);
  if (!parsed) {
    if (cb.id) {
      await answerCallbackQuery(
        c.env.TELEGRAM_BOT_TOKEN,
        cb.id,
        "❌ Invalid callback data",
      );
    }
    return c.json({ ok: true });
  }

  const { action, doName: name, callbackNonce } = parsed;

  // Route to DO by hash name — no KV lookup needed
  const doId = c.env.KEY_SESSION_DO.idFromName(name);
  const stub = c.env.KEY_SESSION_DO.get(
    doId,
  ) as DurableObjectStub<KeySessionDO>;

  // DO validates nonce and returns approval info for display
  let result: {
    ok: boolean;
    error?: string;
    approval?: {
      secretId: string;
      session: string;
      ip: string;
      expiresAt: number;
    };
  };
  if (action === "approve") {
    result = await stub.approve(callbackNonce);
  } else {
    result = await stub.deny(callbackNonce);
  }

  const toastText = result.ok
    ? action === "approve"
      ? "✅ Approved"
      : "❌ Denied"
    : `⚠️ ${result.error ?? "Failed"}`;

  await answerCallbackQuery(c.env.TELEGRAM_BOT_TOKEN, cb.id, toastText);

  // Update the Telegram message to show the result (remove buttons)
  if (result.ok && cb.message && result.approval) {
    const status = action === "approve" ? "approved" : "denied";
    const user = formatTelegramUser(cb.from);
    await updateApprovalMessage(
      c.env.TELEGRAM_BOT_TOKEN,
      cb.message.chat.id,
      cb.message.message_id,
      result.approval.secretId,
      result.approval.session,
      result.approval.ip,
      status,
      result.approval.expiresAt,
      user,
    );
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Web admin — login (approval-based)
// ---------------------------------------------------------------------------

// Config status — lets the login page know what's available
app.get("/admin/status", (c) => {
  const telegram = !!(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID);
  const telegramDisabled = c.env.DISABLE_TELEGRAM_LOGIN === "true";
  const timeoutSeconds = getTimeoutMs(c.env) / 1000;
  // Rate limit status is reported by the login endpoint on failure;
  // we don't call limit() here to avoid consuming a slot.
  return c.json({ telegram, telegramDisabled, timeoutSeconds });
});

// Token-based login — fallback when Telegram is not configured
app.post("/admin/auth/login-token", async (c) => {
  try {
    const body = await c.req.json<{ token: string }>();
    if (!body.token) return c.text("token required", 400);
    if (body.token !== c.env.ADMIN_TOKEN) return c.text("Invalid token", 403);

    const userId =
      typeof c.env.TELEGRAM_CHAT_ID === "string"
        ? parseInt(c.env.TELEGRAM_CHAT_ID, 10)
        : c.env.TELEGRAM_CHAT_ID || 0;
    const cookie = await createSession(userId, c.env.ADMIN_TOKEN);
    return new Response(JSON.stringify({ status: "approved" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", error: message }, 500);
  }
});

app.get("/admin", async (c) => {
  const userId = await verifySession(c.req.raw, c.env.ADMIN_TOKEN);
  if (userId) return c.redirect("/admin/dashboard");
  return c.html(loginPage());
});

app.get("/admin/dashboard", async (c) => {
  const userId = await verifySession(c.req.raw, c.env.ADMIN_TOKEN);
  if (!userId) return c.redirect("/admin");
  const timeoutSeconds = getTimeoutMs(c.env) / 1000;
  return c.html(dashboardPage(timeoutSeconds));
});

app.post("/admin/auth/login", async (c) => {
  try {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For") ??
      "unknown";

    // Rate limit: 1 attempt per 60s globally
    if (c.env.LOGIN_RATE_LIMIT) {
      const { success } = await c.env.LOGIN_RATE_LIMIT.limit({
        key: "telegram-login",
      });
      if (!success) {
        return c.json(
          {
            status: "rate_limited",
            error: "Too many login attempts. Try again in a minute.",
          },
          429,
        );
      }
    }

    // Accept session name from client (for verification display) or generate one
    const body = await c.req.json<{ session?: string }>().catch(() => ({}));
    const nonce = crypto.randomUUID().slice(0, 8);
    const secretId = LOGIN_SECRET_ID;
    let session = body.session || `web-${nonce}`;
    if (session.length > LIMITS.session)
      session = session.slice(0, LIMITS.session);
    if (session.includes("\0"))
      return c.text("session must not contain null byte", 400);

    const name = await doName(secretId, session);
    const doId = c.env.KEY_SESSION_DO.idFromName(name);
    const stub = c.env.KEY_SESSION_DO.get(
      doId,
    ) as DurableObjectStub<KeySessionDO>;

    await stub.init(secretId, session, ip);

    // Cancel pending wait on disconnect — see /secret/:secretId handler.
    const onAbort = () => { waitUntil(stub.cancelWait()); };
    c.req.raw.signal.addEventListener("abort", onAbort);

    const approval = await stub.wait();

    if (approval.status === "approved") {
      const userId =
        typeof c.env.TELEGRAM_CHAT_ID === "string"
          ? parseInt(c.env.TELEGRAM_CHAT_ID, 10)
          : c.env.TELEGRAM_CHAT_ID;
      const cookie = await createSession(userId, c.env.ADMIN_TOKEN);
      return new Response(JSON.stringify({ status: "approved" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookie,
        },
      });
    }

    return c.json({ status: approval.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Login error:", message);
    return c.json({ status: "error", error: message }, 500);
  }
});

app.post("/admin/auth/logout", async (_c) => {
  const cookie = destroySession();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
});

// ---------------------------------------------------------------------------
// Admin API — secret management (Bearer token or session cookie)
// ---------------------------------------------------------------------------

app.get("/admin/api/secrets", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  const { results } = await c.env.DB.prepare(
    "SELECT id, token, cidrs, updated_at FROM secrets ORDER BY updated_at DESC",
  ).all<{ id: string; token: string; cidrs: string; updated_at: number }>();

  return c.json(results ?? []);
});

const LIMITS = { secretId: 128, session: 128, token: 128, cidrs: 512, value: 65536 };

app.put("/admin/api/secrets/:secretId", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  const secretId = c.req.param("secretId");
  if (!secretId) return c.text("secretId required", 400);
  if (secretId === LOGIN_SECRET_ID)
    return c.text("secretId is reserved", 400);
  if (secretId.length > LIMITS.secretId)
    return c.text(`secretId too long (max ${LIMITS.secretId})`, 400);

  const body = await c.req.json<{
    secret?: string;
    token?: string;
    cidrs?: string;
  }>();

  if (
    body.token === undefined &&
    body.secret === undefined &&
    body.cidrs === undefined
  )
    return c.text("at least one of token, secret, or cidrs required", 400);
  if (body.token !== undefined && body.token.length > LIMITS.token)
    return c.text(`token too long (max ${LIMITS.token})`, 400);
  if (body.secret !== undefined && body.secret.length > LIMITS.value)
    return c.text(`secret too long (max ${LIMITS.value})`, 400);
  if (body.cidrs !== undefined && body.cidrs.length > LIMITS.cidrs)
    return c.text(`cidrs too long (max ${LIMITS.cidrs})`, 400);
  if (body.cidrs) {
    const parsed = parseCidrs(body.cidrs);
    if (!parsed.ok) return c.text(parsed.error, 400);
  }

  // Fetch existing row for partial updates
  const existing = await c.env.DB.prepare(
    "SELECT secret, token, cidrs FROM secrets WHERE id = ?",
  )
    .bind(secretId)
    .first<{ secret: string; token: string; cidrs: string }>();

  if (!existing && body.secret === undefined)
    return c.text("Secret not found — provide a value to create", 404);
  if (!existing && body.token === undefined)
    return c.text("Secret not found — provide a token to create", 404);

  const secretValue = body.secret ?? existing?.secret;
  const tokenValue = body.token ?? existing?.token ?? "";
  const cidrsValue = normalizeCidrs(body.cidrs ?? existing?.cidrs ?? "");

  if (!secretValue)
    return c.text("Secret not found — provide a value to create", 404);

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO secrets (id, secret, token, cidrs, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(secretId, secretValue, tokenValue, cidrsValue, Date.now())
    .run();

  return c.json({ ok: true, secretId });
});

app.delete("/admin/api/secrets/:secretId", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  const secretId = c.req.param("secretId");
  if (!secretId) return c.text("secretId required", 400);

  await c.env.DB.prepare("DELETE FROM secrets WHERE id = ?")
    .bind(secretId)
    .run();
  return c.json({ ok: true, secretId });
});

// ---------------------------------------------------------------------------
// Admin — register Telegram webhook
// ---------------------------------------------------------------------------

app.post("/admin/webhook", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({
      ok: false,
      description:
        "TELEGRAM_BOT_TOKEN not set. Run: pnpm wrangler secret put TELEGRAM_BOT_TOKEN",
    });
  }

  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin.replace(/^http:/, "https:")}/telegram/webhook`;
  const result = await registerWebhook(
    c.env.TELEGRAM_BOT_TOKEN,
    webhookUrl,
    c.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  );

  return c.json({ ok: result.ok, webhookUrl, description: result.description });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  // Initialize D1 table on first request
  await initDB(c.env.DB);
  return c.text("ok");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isAdmin(c: {
  req: { header: (name: string) => string | undefined; raw: Request };
  env: Env;
}): Promise<boolean> {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === c.env.ADMIN_TOKEN) {
    return true;
  }
  const userId = await verifySession(c.req.raw, c.env.ADMIN_TOKEN);
  return userId !== null;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7) || undefined;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
export { KeySessionDO } from "./key-session-do";
