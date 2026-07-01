import { DurableObject } from "cloudflare:workers";
import type { Approval } from "./types";
import { sendApprovalMessage } from "./telegram";
import { TIMEOUT_MS } from "./types";

/**
 * Durable Object managing a single secret request session.
 *
 * Uses RPC methods (not fetch handler) and SQLite storage per CF best practices.
 * The `wait()` method returns a Promise that resolves when `approve()` or `deny()`
 * is called, or when the alarm fires (timeout).
 */
export class KeySessionDO extends DurableObject<Env> {
  /** Resolver for the pending wait() call, held in memory. */
  private waitResolver: ((value: Approval) => void) | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS approval (
          secret_id      TEXT NOT NULL,
          session        TEXT NOT NULL,
          secret_value   TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending',
          approval_nonce TEXT NOT NULL,
          ip             TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          notified_at    INTEGER,
          PRIMARY KEY (secret_id, session)
        )
      `);
    });
  }

  /**
   * Initialize or recover a session.
   * Sends a Telegram notification if this is a fresh request or the previous
   * notification has expired.
   */
  async init(
    secretId: string,
    session: string,
    secretValue: string,
    ip: string,
  ): Promise<Approval> {
    // Check for existing session
    const existing = this.loadApproval(secretId, session);
    if (existing) {
      // If already resolved, return immediately
      if (existing.status !== "pending") return existing;

      // If pending and recently notified, just return (caller will wait())
      if (
        existing.notifiedAt &&
        Date.now() - existing.notifiedAt < TIMEOUT_MS
      ) {
        return existing;
      }

      // Pending but notification expired — re-notify
      await this.notify(existing);
      this.updateNotifiedAt(secretId, session, Date.now());
      return { ...existing, notifiedAt: Date.now() };
    }

    // New session
    const approvalNonce = crypto.randomUUID();
    const now = Date.now();
    const approval: Approval = {
      secretId,
      session,
      secretValue,
      status: "pending",
      approvalNonce,
      ip,
      createdAt: now,
      notifiedAt: null,
    };

    this.saveApproval(approval);
    await this.notify(approval);
    this.updateNotifiedAt(secretId, session, now);

    // Set alarm for automatic expiry/cleanup
    await this.ctx.storage.setAlarm(now + TIMEOUT_MS);

    return { ...approval, notifiedAt: now };
  }

  /**
   * Approve a pending request. Validates the approval nonce.
   * Resolves the waiting wait() Promise if one is held.
   */
  async approve(
    secretId: string,
    session: string,
    approvalNonce: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const approval = this.loadApproval(secretId, session);
    if (!approval) return { ok: false, error: "Session not found" };
    if (approval.status !== "pending")
      return { ok: false, error: `Already ${approval.status}` };
    if (approval.approvalNonce !== approvalNonce)
      return { ok: false, error: "Invalid nonce" };

    approval.status = "approved";
    this.updateStatus(secretId, session, "approved");
    this.resolveWait(approval);

    return { ok: true };
  }

  /**
   * Deny a pending request. Validates the approval nonce.
   * Resolves the waiting wait() Promise if one is held.
   */
  async deny(
    secretId: string,
    session: string,
    approvalNonce: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const approval = this.loadApproval(secretId, session);
    if (!approval) return { ok: false, error: "Session not found" };
    if (approval.status !== "pending")
      return { ok: false, error: `Already ${approval.status}` };
    if (approval.approvalNonce !== approvalNonce)
      return { ok: false, error: "Invalid nonce" };

    approval.status = "denied";
    this.updateStatus(secretId, session, "denied");
    this.resolveWait(approval);

    return { ok: true };
  }

  /**
   * Long-poll: returns a Promise that resolves when the request is
   * approved, denied, or expired. The DO processes other RPC calls
   * (approve/deny) while this Promise is pending.
   */
  async wait(secretId: string, session: string): Promise<Approval> {
    const approval = this.loadApproval(secretId, session);
    if (!approval) {
      throw new Error("Session not found");
    }
    if (approval.status !== "pending") {
      return approval;
    }

    // Hold the resolver in memory; approve()/deny()/alarm() will call it
    return new Promise<Approval>((resolve) => {
      this.waitResolver = resolve;
    });
  }

  /**
   * Alarm handler — fires on timeout.
   * Marks the request as expired and resolves any waiting wait() call.
   */
  async alarm(): Promise<void> {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT secret_id, session FROM approval WHERE status = 'pending'`,
    );
    const rows = cursor.toArray();
    for (const row of rows) {
      const secretId = row.secret_id as string;
      const session = row.session as string;
      this.updateStatus(secretId, session, "expired");

      const approval = this.loadApproval(secretId, session);
      if (approval) {
        this.resolveWait(approval);
      }
    }
  }

  // --- Private helpers ---

  private loadApproval(secretId: string, session: string): Approval | null {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM approval WHERE secret_id = ? AND session = ?`,
      secretId,
      session,
    );
    const row = cursor.toArray()[0];
    if (!row) return null;
    return {
      secretId: row.secret_id as string,
      session: row.session as string,
      secretValue: row.secret_value as string,
      status: row.status as Approval["status"],
      approvalNonce: row.approval_nonce as string,
      ip: row.ip as string,
      createdAt: row.created_at as number,
      notifiedAt: row.notified_at as number | null,
    };
  }

  private saveApproval(a: Approval): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO approval (secret_id, session, secret_value, status, approval_nonce, ip, created_at, notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      a.secretId,
      a.session,
      a.secretValue,
      a.status,
      a.approvalNonce,
      a.ip,
      a.createdAt,
      a.notifiedAt,
    );
  }

  private updateStatus(
    secretId: string,
    session: string,
    status: Approval["status"],
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE approval SET status = ? WHERE secret_id = ? AND session = ?`,
      status,
      secretId,
      session,
    );
  }

  private updateNotifiedAt(
    secretId: string,
    session: string,
    notifiedAt: number,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE approval SET notified_at = ? WHERE secret_id = ? AND session = ?`,
      notifiedAt,
      secretId,
      session,
    );
  }

  private resolveWait(approval: Approval): void {
    if (this.waitResolver) {
      const updated = this.loadApproval(approval.secretId, approval.session);
      this.waitResolver(updated ?? approval);
      this.waitResolver = null;
    }
  }

  private async notify(approval: Approval): Promise<void> {
    await sendApprovalMessage(
      this.env.TELEGRAM_BOT_TOKEN,
      this.env.TELEGRAM_CHAT_ID,
      approval.secretId,
      approval.session,
      approval.ip,
      approval.approvalNonce,
      this.env.SECRETS,
    );
  }
}
