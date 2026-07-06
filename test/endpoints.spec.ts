import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../src";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Stub the global fetch so the Worker never reaches the real Telegram API.
 * All telegram.ts call sites (sendMessage, editMessageText, answerCallbackQuery,
 * setWebhook) receive a successful-looking JSON response. Returning a `vi.fn`
 * lets each test assert call counts / payloads if needed.
 */
const telegramJsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/sendMessage")) {
        return telegramJsonResponse({ ok: true, result: { message_id: 4242 } });
      }
      if (url.includes("/editMessageText")) {
        return telegramJsonResponse({ ok: true, result: { message_id: 4242 } });
      }
      if (url.includes("/answerCallbackQuery")) {
        return telegramJsonResponse({ ok: true, result: true });
      }
      if (url.includes("/setWebhook")) {
        return telegramJsonResponse({ ok: true, result: true });
      }
      return new Response("not stubbed", { status: 404 });
    }),
  );
});

/** Initialize the D1 secrets table. */
async function initDB() {
  const req = new IncomingRequest("http://localhost/");
  const ctx = createExecutionContext();
  await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
}

/** Insert a secret directly into D1 for testing. */
async function insertSecret(
  id: string,
  secret: string,
  token: string,
  cidrs: string = "",
) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO secrets (id, secret, token, cidrs, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, secret, token, cidrs, Date.now())
    .run();
}

/** Delete a secret from D1. */
async function deleteSecret(id: string) {
  await env.DB.prepare("DELETE FROM secrets WHERE id = ?").bind(id).run();
}

describe("Health endpoint", () => {
  it("GET / returns ok", async () => {
    const req = new IncomingRequest("http://localhost/");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });
});

describe("Secret retrieval — token", () => {
  it("GET /secret/:id without token returns 401", async () => {
    await initDB();
    await insertSecret("token-test", "s3cret", "tok123");
    const req = new IncomingRequest("http://localhost/secret/token-test");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toContain("token required");
    await deleteSecret("token-test");
  });

  it("GET /secret/:id with token for non-existent secret returns 404", async () => {
    const req = new IncomingRequest(
      "http://localhost/secret/nonexistent?token=abc",
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Secret not found");
  });

  it("GET /secret/:id with Bearer header works", async () => {
    const req = new IncomingRequest("http://localhost/secret/nonexistent", {
      headers: { Authorization: "Bearer some-token" },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    // Secret doesn't exist, but token was accepted (not 401)
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Secret not found");
  });
});

describe("Admin API — token", () => {
  it("GET /admin/api/secrets without token returns 401", async () => {
    const req = new IncomingRequest("http://localhost/admin/api/secrets");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
  });

  it("PUT /admin/api/secrets/:id without token returns 401", async () => {
    const req = new IncomingRequest("http://localhost/admin/api/secrets/test", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "value", token: "tok" }),
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
  });

  it("DELETE /admin/api/secrets/:id without token returns 401", async () => {
    const req = new IncomingRequest("http://localhost/admin/api/secrets/test", {
      method: "DELETE",
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
  });
});

describe("Telegram webhook", () => {
  it("POST /telegram/webhook without callback_query returns ok", async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Include webhook secret if configured in test environment
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      headers["X-Telegram-Bot-Api-Secret-Token"] = env.TELEGRAM_WEBHOOK_SECRET;
    }
    const req = new IncomingRequest("http://localhost/telegram/webhook", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
  });
});

describe("Admin pages", () => {
  it("GET /admin without session returns login page", async () => {
    const req = new IncomingRequest("http://localhost/admin");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("keywa");
    expect(html).toContain("Login");
  });
});

describe("Secret retrieval — CIDR", () => {
  beforeEach(async () => {
    await initDB();
    await deleteSecret("cidr-test");
  });

  it("rejects IP outside CIDR range", async () => {
    await insertSecret("cidr-test", "s3cret", "tok123", "10.0.0.0/8");
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "192.168.1.1" } },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("IP not allowed");
  });

  it("rejects IP outside plain IP allowlist", async () => {
    await insertSecret("cidr-test", "s3cret", "tok123", "10.0.0.1");
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "10.0.0.2" } },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("IP not allowed");
  });

  it("rejects IP outside multiple CIDRs", async () => {
    await insertSecret(
      "cidr-test",
      "s3cret",
      "tok123",
      "10.0.0.0/8, 172.16.0.0/12",
    );
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "192.168.1.1" } },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("IP not allowed");
  });

  it("rejects IPv4-mapped IPv6 outside CIDR range", async () => {
    await insertSecret("cidr-test", "s3cret", "tok123", "10.0.0.0/8");
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "::ffff:192.168.1.1" } },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("IP not allowed");
  });

  it("rejects IPv6 client against IPv4-only CIDR (family mismatch)", async () => {
    // Regression: ipaddr.match() throws on family mismatch — must filter to
    // same family first, not let the throw escape as 500.
    await insertSecret("cidr-test", "s3cret", "tok123", "10.0.0.0/8");
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "2001:db8::1" } },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("IP not allowed");
  });

  it("skips CIDR check when cidrs is empty", async () => {
    // Verify that empty cidrs doesn't cause a 403 — the request proceeds
    // past CIDR check to the DO (which long-polls). We test the fast-reject
    // path only; the skip path is confirmed by absence of 403.
    await insertSecret("cidr-test", "s3cret", "tok123", "");
    const req = new IncomingRequest(
      "http://localhost/secret/cidr-test?token=tok123",
      { headers: { "CF-Connecting-IP": "192.168.1.1" } },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    // Race against a short timeout — if CIDR check doesn't block, we get a response
    const resp = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => r(new Response("timeout", { status: 599 })), 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    // 599 = our timeout (CIDR check passed, DO is blocking). 403 = CIDR rejected.
    expect(resp.status).not.toBe(403);
  });
});

describe("Secret retrieval — ?timeout=", () => {
  beforeEach(async () => {
    await initDB();
    await deleteSecret("timeout-test");
  });

  // These tests confirm parsing/clamping at the Worker boundary. The DO-side
  // enforcement of the clamped value is covered in durable-object.spec.ts
  // (which asserts Approval.expiresAt directly).

  it("?timeout=abc returns 400", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=abc",
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("timeout must be");
    await deleteSecret("timeout-test");
  });

  it("?timeout=1.5 accepted (parseInt truncates to 1)", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=1.5",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    // parseInt("1.5") = 1 → clamped to min 1s. Request proceeds (no 400).
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout= 5 (leading space) accepted — parseInt trims", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=%205",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    // Race a short timeout; abort the Worker fetch so waitOnExecutionContext
    // doesn't block on the DO long-poll.
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout=99999 accepted (clamped to MAX, not rejected)", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=99999",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    // No 400 — clamped to MAX_TIMEOUT_SECONDS (30s in test env). The request
    // proceeds past validation.
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout=-5 accepted (clamped to 1, not rejected)", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=-5",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout=0 accepted (sentinel for default = MAX)", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=0",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout= (empty) treated as absent (no 400)", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const ac = new AbortController();
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=",
      { signal: ac.signal },
    );
    const ctx = createExecutionContext();
    const respPromise = worker.fetch(req, env, ctx);
    const race = await Promise.race([
      respPromise,
      new Promise<Response>((r) =>
        setTimeout(() => {
          ac.abort();
          r(new Response("timeout", { status: 599 }));
        }, 500),
      ),
    ]);
    await waitOnExecutionContext(ctx);
    expect(race.status).not.toBe(400);
    await deleteSecret("timeout-test");
  });

  it("?timeout with null byte returns 400", async () => {
    await insertSecret("timeout-test", "s3cret", "tok123", "");
    const req = new IncomingRequest(
      "http://localhost/secret/timeout-test?token=tok123&timeout=5%00",
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("null byte");
    await deleteSecret("timeout-test");
  });
});

describe("Admin API — CIDR validation", () => {
  beforeEach(async () => {
    await initDB();
    await deleteSecret("cidr-val-test");
  });

  it("PUT rejects invalid CIDR", async () => {
    const req = new IncomingRequest(
      "http://localhost/admin/api/secrets/cidr-val-test",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ secret: "val", cidrs: "not-a-cidr" }),
      },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("Invalid CIDR");
  });

  it("PUT accepts valid CIDRs", async () => {
    const req = new IncomingRequest(
      "http://localhost/admin/api/secrets/cidr-val-test",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          secret: "val",
          token: "tok",
          cidrs: "192.168.1.0/24, 10.0.0.0/8",
        }),
      },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
  });
});
