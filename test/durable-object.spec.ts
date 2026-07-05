import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KeySessionDO } from "../src/key-session-do";

/**
 * Stub global fetch so the DO never reaches the real Telegram API. Avoids
 * rate-limit failures and keeps tests deterministic.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("/sendMessage")
        ? { ok: true, result: { message_id: 4242 } }
        : { ok: true, result: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

describe("KeySessionDO", () => {
  function getStub(secretId: string, session: string) {
    const id = env.KEY_SESSION_DO.idFromName(`${secretId}/${session}`);
    return env.KEY_SESSION_DO.get(id);
  }

  it("init creates a new pending approval", async () => {
    const stub = getStub("s1", "r1");
    const approval = await stub.init("s1", "r1", "127.0.0.1", "my-secret");

    expect(approval.status).toBe("pending");
    expect(approval.secretId).toBe("s1");
    expect(approval.session).toBe("r1");
    expect(approval.ip).toBe("127.0.0.1");
    expect(approval.callbackNonce).toBeTruthy();
    expect(approval.expiresAt).toBeGreaterThan(Date.now());
    expect(approval.secret).toBe("my-secret");
  }, 15000);

  it("approve resolves a pending approval", async () => {
    const stub = getStub("s2", "r1");
    const approval = await stub.init("s2", "r1", "127.0.0.1");

    const result = await stub.approve(approval.callbackNonce);
    expect(result.ok).toBe(true);
    expect(result.approval).toBeTruthy();
    expect(result.approval!.status).toBe("approved");

    // State persists until retrieved via wait() or init() — second approve reports already resolved
    const result2 = await stub.approve(approval.callbackNonce);
    expect(result2.ok).toBe(false);
    expect(result2.error).toBe("Already approved");
  }, 15000);

  it("approve rejects invalid nonce", async () => {
    const stub = getStub("s3", "r1");
    await stub.init("s3", "r1", "127.0.0.1");

    const result = await stub.approve("wrong-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid nonce");
  }, 15000);

  it("deny resolves a pending approval", async () => {
    const stub = getStub("s4", "r1");
    const approval = await stub.init("s4", "r1", "127.0.0.1");

    const result = await stub.deny(approval.callbackNonce);
    expect(result.ok).toBe(true);
    expect(result.approval).toBeTruthy();
    expect(result.approval!.status).toBe("denied");

    // State is kept for disconnected clients — second deny reports already resolved
    const result2 = await stub.deny(approval.callbackNonce);
    expect(result2.ok).toBe(false);
    expect(result2.error).toBe("Already denied");
  }, 15000);

  it("alarm expires pending approvals and cleans up", async () => {
    const stub = getStub("s5", "r1");
    await stub.init("s5", "r1", "127.0.0.1");

    // Run the alarm
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // After alarm, state is cleaned up — init again should create fresh
    const fresh = await stub.init("s5", "r1", "127.0.0.1");
    expect(fresh.status).toBe("pending");
  }, 15000);

  it("wait resolves when approved", async () => {
    const stub = getStub("s6", "r1");
    const approval = await stub.init("s6", "r1", "127.0.0.1", "super-secret");

    // Start waiting (in background)
    const waitPromise = stub.wait();

    // Approve
    await stub.approve(approval.callbackNonce);

    const result = await waitPromise;
    expect(result.status).toBe("approved");
    expect(result.secret).toBe("super-secret");
  }, 15000);

  it("wait resolves when denied", async () => {
    const stub = getStub("s7", "r1");
    const approval = await stub.init("s7", "r1", "127.0.0.1");

    const waitPromise = stub.wait();
    await stub.deny(approval.callbackNonce);

    const result = await waitPromise;
    expect(result.status).toBe("denied");
  }, 15000);

  it("wait cleans up DO after resolving", async () => {
    const stub = getStub("s6b", "r1");
    const approval = await stub.init("s6b", "r1", "127.0.0.1");

    const waitPromise = stub.wait();
    await stub.approve(approval.callbackNonce);
    const result = await waitPromise;
    expect(result.status).toBe("approved");

    // DO was cleaned up — next init creates a fresh request
    const fresh = await stub.init("s6b", "r1", "127.0.0.1");
    expect(fresh.status).toBe("pending");
  }, 15000);

  it("init returns resolved state after approval (disconnected client)", async () => {
    const stub = getStub("s8", "r1");
    const approval = await stub.init(
      "s8",
      "r1",
      "127.0.0.1",
      "reconnect-secret",
    );

    // Approve the request
    await stub.approve(approval.callbackNonce);

    // New init on the same DO should return the approved result with secret
    const recovered = await stub.init("s8", "r1", "127.0.0.1");
    expect(recovered.status).toBe("approved");
    expect(recovered.secretId).toBe("s8");
    expect(recovered.secret).toBe("reconnect-secret");

    // DO was cleaned up after retrieval — next init creates a fresh request
    const fresh = await stub.init("s8", "r1", "127.0.0.1");
    expect(fresh.status).toBe("pending");
    expect(fresh.secretId).toBe("s8");
  }, 15000);

  it("init updates pending request in place when IP changes (no listener)", async () => {
    const stub = getStub("s9", "r1");
    const first = await stub.init("s9", "r1", "1.1.1.1");
    expect(first.status).toBe("pending");

    // Simulate client disconnect: no wait() was called, so waitResolver
    // is null. A new init() with different IP revokes nonce and updates.
    const second = await stub.init("s9", "r1", "2.2.2.2");
    expect(second.status).toBe("pending");
    expect(second.ip).toBe("2.2.2.2");
    expect(second.callbackNonce).not.toBe(first.callbackNonce);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
  }, 15000);

  it("init preserves pending request when IP matches (no listener)", async () => {
    const stub = getStub("s9b", "r1");
    const first = await stub.init("s9b", "r1", "1.1.1.1", "old-secret");
    expect(first.status).toBe("pending");

    // Same IP, no listener — preserve state, update secret and expiry.
    const second = await stub.init("s9b", "r1", "1.1.1.1", "new-secret");
    expect(second.status).toBe("pending");
    expect(second.ip).toBe("1.1.1.1");
    expect(second.callbackNonce).toBe(first.callbackNonce);
    expect(second.secret).toBe("new-secret");
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
  }, 15000);

  it("init allows retry after disconnect (cancelWait clears resolver)", async () => {
    const stub = getStub("s10", "r1");
    const first = await stub.init("s10", "r1", "1.1.1.1");
    expect(first.status).toBe("pending");

    // Simulate: client starts waiting, then disconnects.
    // In production, the Worker calls cancelWait() on HTTP abort.
    const _wait = stub.wait();
    await stub.cancelWait();

    // Client retries with a new init() — should NOT get 409.
    const retry = await stub.init("s10", "r1", "2.2.2.2");
    expect(retry.status).toBe("pending");
    expect(retry.ip).toBe("2.2.2.2");
    expect(retry.callbackNonce).not.toBe(first.callbackNonce);
  }, 15000);

  // Note: duplicate pending requests throw "Request already pending",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.

  // Note: wait() on non-existent session throws "Session not found",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.

  it("init honors explicit timeoutMs for expiresAt", async () => {
    const stub = getStub("s11", "r1");
    const before = Date.now();
    const approval = await stub.init("s11", "r1", "127.0.0.1", "x", 5_000);
    const after = Date.now();

    expect(approval.status).toBe("pending");
    // expiresAt should be within [before+5s, after+5s] — tolerance for clock drift
    expect(approval.expiresAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(approval.expiresAt).toBeLessThanOrEqual(after + 5_000);
  }, 15000);

  it("Case 3 reuse recomputes expiresAt from current timeoutMs", async () => {
    const stub = getStub("s12", "r1");
    // First init with a short timeout; no wait() → Case 3 path on reconnect.
    const first = await stub.init("s12", "r1", "1.1.1.1", undefined, 2_000);
    const firstExpiry = first.expiresAt;

    // Wait past first expiry to be sure the new value reflects the new param.
    await new Promise((r) => setTimeout(r, 10));

    // Reconnect with a longer timeout — expiresAt must move forward.
    const before = Date.now();
    const second = await stub.init("s12", "r1", "1.1.1.1", undefined, 10_000);
    const after = Date.now();

    expect(second.status).toBe("pending");
    expect(second.expiresAt).toBeGreaterThan(firstExpiry);
    expect(second.expiresAt).toBeGreaterThanOrEqual(before + 10_000);
    expect(second.expiresAt).toBeLessThanOrEqual(after + 10_000);
    // Same IP → nonce preserved
    expect(second.callbackNonce).toBe(first.callbackNonce);
  }, 15000);

  it("Case 3 reuse falls back to env MAX_TIMEOUT_SECONDS when timeoutMs omitted", async () => {
    const stub = getStub("s13", "r1");
    // No timeoutMs → uses env default (3600s from test env default, or
    // whatever the runner's wrangler.toml sets).
    const approval = await stub.init("s13", "r1", "127.0.0.1");
    expect(approval.status).toBe("pending");
    // Should be at least an hour out (default MAX) — generous lower bound
    // to tolerate the local-dev wrangler.toml override (30s).
    expect(approval.expiresAt).toBeGreaterThan(Date.now() + 10_000);
  }, 15000);
});
