import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { KeySessionDO } from "../src/key-session-do";

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
  });

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
  });

  it("approve rejects invalid nonce", async () => {
    const stub = getStub("s3", "r1");
    await stub.init("s3", "r1", "127.0.0.1");

    const result = await stub.approve("wrong-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid nonce");
  });

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
  });

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
  });

  it("wait resolves when denied", async () => {
    const stub = getStub("s7", "r1");
    const approval = await stub.init("s7", "r1", "127.0.0.1");

    const waitPromise = stub.wait();
    await stub.deny(approval.callbackNonce);

    const result = await waitPromise;
    expect(result.status).toBe("denied");
  });

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
    const approval = await stub.init("s8", "r1", "127.0.0.1", "reconnect-secret");

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
  });

  it("init cleans up abandoned pending and creates fresh request", async () => {
    const stub = getStub("s9", "r1");
    const first = await stub.init("s9", "r1", "1.1.1.1");
    expect(first.status).toBe("pending");

    // Simulate client disconnect: no wait() was called, so waitResolvers
    // is empty. A new init() should clean up and create a fresh request.
    const second = await stub.init("s9", "r1", "2.2.2.2");
    expect(second.status).toBe("pending");
    expect(second.ip).toBe("2.2.2.2");
    expect(second.callbackNonce).not.toBe(first.callbackNonce);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
  }, 15000);

  // Note: duplicate pending requests throw "Request already pending",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.

  // Note: wait() on non-existent session throws "Session not found",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.
});
