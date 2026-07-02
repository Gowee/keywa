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
    const approval = await stub.init("s1", "r1", "127.0.0.1");

    expect(approval.status).toBe("pending");
    expect(approval.secretId).toBe("s1");
    expect(approval.session).toBe("r1");
    expect(approval.ip).toBe("127.0.0.1");
    expect(approval.callbackNonce).toBeTruthy();
    expect(approval.expiresAt).toBeGreaterThan(Date.now());
  });

  it("approve resolves a pending approval and cleans up", async () => {
    const stub = getStub("s2", "r1");
    const approval = await stub.init("s2", "r1", "127.0.0.1");

    const result = await stub.approve(approval.callbackNonce);
    expect(result.ok).toBe(true);
    expect(result.approval).toBeTruthy();
    expect(result.approval!.status).toBe("approved");

    // State is cleaned up — second approve finds nothing
    const result2 = await stub.approve(approval.callbackNonce);
    expect(result2.ok).toBe(false);
    expect(result2.error).toBe("Session not found");
  });

  it("approve rejects invalid nonce", async () => {
    const stub = getStub("s3", "r1");
    await stub.init("s3", "r1", "127.0.0.1");

    const result = await stub.approve("wrong-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid nonce");
  });

  it("deny resolves a pending approval and cleans up", async () => {
    const stub = getStub("s4", "r1");
    const approval = await stub.init("s4", "r1", "127.0.0.1");

    const result = await stub.deny(approval.callbackNonce);
    expect(result.ok).toBe(true);
    expect(result.approval).toBeTruthy();
    expect(result.approval!.status).toBe("denied");

    // State is cleaned up
    const result2 = await stub.deny(approval.callbackNonce);
    expect(result2.ok).toBe(false);
    expect(result2.error).toBe("Session not found");
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
    const approval = await stub.init("s6", "r1", "127.0.0.1");

    // Start waiting (in background)
    const waitPromise = stub.wait();

    // Approve
    await stub.approve(approval.callbackNonce);

    const result = await waitPromise;
    expect(result.status).toBe("approved");
  });

  it("wait resolves when denied", async () => {
    const stub = getStub("s7", "r1");
    const approval = await stub.init("s7", "r1", "127.0.0.1");

    const waitPromise = stub.wait();
    await stub.deny(approval.callbackNonce);

    const result = await waitPromise;
    expect(result.status).toBe("denied");
  });

  // Note: duplicate pending requests throw "Request already pending",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.

  // Note: wait() on non-existent session throws "Session not found",
  // but testing this via RPC causes unhandled rejection warnings in the CF test pool.
});
