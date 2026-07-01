import { Hono } from "hono";
import type { Env, StoredSecret } from "./types";
import { DEFAULT_SESSION } from "./types";
import {
  parseCallbackData,
  answerCallbackQuery,
  updateApprovalMessage,
  registerWebhook,
} from "./telegram";
import { createSession, verifySession, destroySession } from "./telegram-auth";
import { loginPage, dashboardPage } from "./admin-ui";
import { KeySessionDO } from "./key-session-do";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Secret retrieval — long-poll until approved
// ---------------------------------------------------------------------------

app.get("/secret/:secretId", (c) => handleSecretRequest(c));
app.get("/secret/:secretId/:session", (c) => handleSecretRequest(c));

async function handleSecretRequest(
  c: Parameters<Parameters<typeof app.get>[1]>[0],
) {
  const secretId = c.req.param("secretId");
  const session = c.req.param("session") ?? DEFAULT_SESSION;
  const secretToken =
    c.req.query("token") ?? extractBearerToken(c.req.header("Authorization"));
  const ip =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For") ??
    "unknown";

  if (!secretId) return c.text("secretId required", 400);
  if (!secretToken)
    return c.text("token required (query param or Bearer header)", 401);

  const raw = await c.env.SECRETS.get(secretId);
  if (!raw) return c.text("Secret not found", 404);

  let stored: StoredSecret;
  try {
    stored = JSON.parse(raw) as StoredSecret;
  } catch {
    return c.text("Secret format invalid", 500);
  }

  if (stored.token !== secretToken) return c.text("Invalid token", 403);

  const doId = c.env.KEY_SESSION_DO.idFromName(`${secretId}/${session}`);
  const stub = c.env.KEY_SESSION_DO.get(
    doId,
  ) as DurableObjectStub<KeySessionDO>;

  await stub.init(secretId, session, stored.secret, ip);
  const approval = await stub.wait(secretId, session);

  switch (approval.status) {
    case "approved":
      return c.text(approval.secretValue);
    case "denied":
      return c.text("Denied", 403);
    case "expired":
      return c.text("Timeout", 408);
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

  const { action, approvalNonce } = parsed;

  const mapping = await c.env.SECRETS.get(`cb:${approvalNonce}`);
  if (!mapping) {
    await answerCallbackQuery(
      c.env.TELEGRAM_BOT_TOKEN,
      cb.id,
      "❌ Request expired or not found",
    );
    return c.json({ ok: true });
  }

  const { secretId, session, ip } = JSON.parse(mapping) as {
    secretId: string;
    session: string;
    ip: string;
  };

  const doId = c.env.KEY_SESSION_DO.idFromName(`${secretId}/${session}`);
  const stub = c.env.KEY_SESSION_DO.get(
    doId,
  ) as DurableObjectStub<KeySessionDO>;

  let result: { ok: boolean; error?: string };
  if (action === "approve") {
    result = await stub.approve(secretId, session, approvalNonce);
  } else {
    result = await stub.deny(secretId, session, approvalNonce);
  }

  const toastText = result.ok
    ? action === "approve"
      ? "✅ Approved"
      : "❌ Denied"
    : `⚠️ ${result.error ?? "Failed"}`;

  await answerCallbackQuery(c.env.TELEGRAM_BOT_TOKEN, cb.id, toastText);

  // Update the Telegram message to show the result (remove buttons)
  if (result.ok && cb.message) {
    const status = action === "approve" ? "approved" : "denied";
    const user = formatTelegramUser(cb.from);
    await updateApprovalMessage(
      c.env.TELEGRAM_BOT_TOKEN,
      cb.message.chat.id,
      cb.message.message_id,
      secretId,
      session,
      ip,
      status,
      user,
    );
  }

  await c.env.SECRETS.delete(`cb:${approvalNonce}`);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Web admin — login (approval-based)
// ---------------------------------------------------------------------------

// Config status — lets the login page know what's available
app.get("/admin/status", (c) => {
  return c.json({
    telegram: !!(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID),
  });
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
    const cookie = await createSession(
      userId,
      c.env.ADMIN_TOKEN,
      c.env.SECRETS,
    );
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
  const userId = await verifySession(
    c.req.raw,
    c.env.ADMIN_TOKEN,
    c.env.SECRETS,
  );
  if (userId) return c.redirect("/admin/dashboard");
  return c.html(loginPage());
});

app.get("/admin/dashboard", async (c) => {
  const userId = await verifySession(
    c.req.raw,
    c.env.ADMIN_TOKEN,
    c.env.SECRETS,
  );
  if (!userId) return c.redirect("/admin");
  return c.html(dashboardPage());
});

app.post("/admin/auth/login", async (c) => {
  try {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For") ??
      "unknown";

    // Accept session name from client (for verification display) or generate one
    const body = await c.req.json<{ session?: string }>().catch(() => ({}));
    const nonce = crypto.randomUUID().slice(0, 8);
    const secretId = `__auth__`;
    const session = body.session || `login-${nonce}`;

    const doId = c.env.KEY_SESSION_DO.idFromName(`${secretId}/${session}`);
    const stub = c.env.KEY_SESSION_DO.get(
      doId,
    ) as DurableObjectStub<KeySessionDO>;

    await stub.init(secretId, session, "", ip);
    const approval = await stub.wait(secretId, session);

    if (approval.status === "approved") {
      const userId =
        typeof c.env.TELEGRAM_CHAT_ID === "string"
          ? parseInt(c.env.TELEGRAM_CHAT_ID, 10)
          : c.env.TELEGRAM_CHAT_ID;
      const cookie = await createSession(
        userId,
        c.env.ADMIN_TOKEN,
        c.env.SECRETS,
      );
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

app.post("/admin/auth/logout", async (c) => {
  const cookie = await destroySession(
    c.req.raw,
    c.env.ADMIN_TOKEN,
    c.env.SECRETS,
  );
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

  const list = await c.env.SECRETS.list();
  const secrets = [];
  for (const key of list.keys) {
    if (key.name.startsWith("session:") || key.name.startsWith("cb:")) continue;
    const raw = await c.env.SECRETS.get(key.name);
    if (!raw) continue;
    try {
      const stored = JSON.parse(raw) as StoredSecret;
      secrets.push({ id: key.name, token: stored.token });
    } catch {
      // skip malformed entries
    }
  }

  return c.json(secrets);
});

const LIMITS = { secretId: 128, token: 128, value: 65536 };

app.put("/admin/api/secrets/:secretId", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  const secretId = c.req.param("secretId");
  if (!secretId) return c.text("secretId required", 400);
  if (secretId.length > LIMITS.secretId)
    return c.text(`secretId too long (max ${LIMITS.secretId})`, 400);

  const body = await c.req.json<{ secret?: string; token?: string }>();

  if (!body.token) return c.text("token required", 400);
  if (body.token.length > LIMITS.token)
    return c.text(`token too long (max ${LIMITS.token})`, 400);
  if (body.secret !== undefined && body.secret.length > LIMITS.value)
    return c.text(`secret too long (max ${LIMITS.value})`, 400);

  // Partial update: if secret is not provided, keep the existing value
  let secretValue: string;
  if (body.secret !== undefined) {
    secretValue = body.secret;
  } else {
    const existing = await c.env.SECRETS.get(secretId);
    if (!existing)
      return c.text(
        "Secret not found — cannot update token without existing secret",
        404,
      );
    try {
      const stored = JSON.parse(existing) as StoredSecret;
      secretValue = stored.secret;
    } catch {
      return c.text("Existing secret format invalid", 500);
    }
  }

  const stored: StoredSecret = { secret: secretValue, token: body.token };
  await c.env.SECRETS.put(secretId, JSON.stringify(stored));

  return c.json({ ok: true, secretId });
});

app.delete("/admin/api/secrets/:secretId", async (c) => {
  if (!(await isAdmin(c))) return c.text("Unauthorized", 401);

  const secretId = c.req.param("secretId");
  if (!secretId) return c.text("secretId required", 400);

  await c.env.SECRETS.delete(secretId);
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

app.get("/", (c) => c.text("ok"));

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
  const userId = await verifySession(
    c.req.raw,
    c.env.ADMIN_TOKEN,
    c.env.SECRETS,
  );
  return userId !== null;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7) || undefined;
}

/** Format Telegram user as a MarkdownV2 link: "FirstName LastName" → tg://user?id=... */
function formatTelegramUser(from?: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): string | undefined {
  if (!from) return undefined;

  const escape = (s: string) =>
    s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\$1");

  // Prefer "FirstName LastName", fallback to @username, then numeric ID
  const label = from.first_name
    ? escape([from.first_name, from.last_name].filter(Boolean).join(" "))
    : from.username
      ? `@${escape(from.username)}`
      : String(from.id);

  return `[${label}](tg://user?id=${from.id})`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
export { KeySessionDO } from "./key-session-do";
