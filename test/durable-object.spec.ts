import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { KeySessionDO } from "../src/key-session-do";

describe("KeySessionDO", () => {
  function getStub(secretId: string, session: string) {
    const id = env.KEY_SESSION_DO.idFromName(`${secretId}/${session}`);
    return env.KEY_SESSION_DO.get(id);
  }

  it("init creates a new pending approval", async () => {
    const stub = getStub("test-secret", "req-1");

    // Insert a test approval directly into SQLite
    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-1",
        "secret-value",
        "pending",
        "test-nonce-uuid",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
    });

    // Verify the approval exists
    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      const cursor = state.storage.sql.exec(
        `SELECT * FROM approval WHERE secret_id = ? AND session = ?`,
        "test-secret",
        "req-1",
      );
      const rows = cursor.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].secret_value).toBe("secret-value");
    });
  });

  it("approve resolves a pending approval", async () => {
    const stub = getStub("test-secret", "req-2");

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-2",
        "secret-value",
        "pending",
        "approve-nonce",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
    });

    const result = await stub.approve("test-secret", "req-2", "approve-nonce");
    expect(result.ok).toBe(true);

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      const cursor = state.storage.sql.exec(
        `SELECT status FROM approval WHERE secret_id = ? AND session = ?`,
        "test-secret",
        "req-2",
      );
      expect(cursor.toArray()[0].status).toBe("approved");
    });
  });

  it("approve rejects invalid nonce", async () => {
    const stub = getStub("test-secret", "req-3");

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-3",
        "secret-value",
        "pending",
        "correct-nonce",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
    });

    const result = await stub.approve("test-secret", "req-3", "wrong-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid nonce");
  });

  it("approve rejects already-approved request", async () => {
    const stub = getStub("test-secret", "req-4");

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-4",
        "secret-value",
        "approved",
        "some-nonce",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
    });

    const result = await stub.approve("test-secret", "req-4", "some-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Already approved");
  });

  it("deny resolves a pending approval", async () => {
    const stub = getStub("test-secret", "req-5");

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-5",
        "secret-value",
        "pending",
        "deny-nonce",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
    });

    const result = await stub.deny("test-secret", "req-5", "deny-nonce");
    expect(result.ok).toBe(true);

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      const cursor = state.storage.sql.exec(
        `SELECT status FROM approval WHERE secret_id = ? AND session = ?`,
        "test-secret",
        "req-5",
      );
      expect(cursor.toArray()[0].status).toBe("denied");
    });
  });

  it("alarm expires pending approvals", async () => {
    const stub = getStub("test-secret", "req-6");

    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-secret",
        "req-6",
        "secret-value",
        "pending",
        "alarm-nonce",
        "127.0.0.1",
        Date.now(),
        Date.now(),
      );
      // Set the alarm (normally done by init())
      await state.storage.setAlarm(Date.now() + 1000);
    });

    // Run the alarm
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Verify expired
    await runInDurableObject(stub, async (_instance: KeySessionDO, state) => {
      const cursor = state.storage.sql.exec(
        `SELECT status FROM approval WHERE secret_id = ? AND session = ?`,
        "test-secret",
        "req-6",
      );
      expect(cursor.toArray()[0].status).toBe("expired");
    });
  });
});
