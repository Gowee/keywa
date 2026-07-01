import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
    const req = new IncomingRequest("http://localhost/secret/test");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toContain("token required");
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
