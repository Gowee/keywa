import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
    const req = new IncomingRequest("http://localhost/secret/nonexistent?token=abc");
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
