import { DurableObject } from "cloudflare:workers";
import type { Approval } from "./types";
import { getMaxTimeoutMs } from "./types";
import {
  sendApprovalMessage,
  updateApprovalMessage,
  refreshApprovalMessage,
} from "./telegram";
import { randomNonce } from "./crypto";

/**
 * Durable Object managing a single secret request session.
 *
 * Uses RPC methods (not fetch handler) and KV storage.
 * The `wait()` method returns a Promise that resolves when `approve()` or `deny()`
 * is called, or when the alarm fires (timeout).
 *
 * Storage: a single KV key "state" containing the request state as JSON,
 * including the secret value captured at init time.
 *
 * Lifecycle:
 *   init()      → store state, set alarm, notify Telegram; or return resolved result and clean up
 *   wait()      → hold Promise in memory; on resolve → clean up state, cancel alarm
 *   cancelWait() → clear stale resolver (called by Worker on client disconnect)
 *   approve()   → validate nonce, resolve wait()
 *   deny()      → validate nonce, resolve wait()
 *   alarm()     → clean up state and resolve pending waiters
 *
 * Duplicate-request policy:
 *   - If there is an active listener (waitResolver !== null), a new init()
 *     is rejected with "Request already pending" to prevent multiple clients
 *     from silently receiving the same secret on one approval.
 *   - The Worker calls cancelWait() when the client's HTTP connection drops
 *     (abort signal + waitUntil), so a retrying client sees no active listener
 *     and gets a fresh request instead of 409.
 *   - Pending requests with no listener are preserved (not recreated).
 *     If IP changed, the nonce is revoked and the Telegram message is
 *     refreshed in-place. Same-IP retries silently reattach.
 *   - If the request was already resolved (approved/denied), init() returns
 *     the result immediately and cleans up the DO. Future requests to the
 *     same (secretId, session) trigger a fresh approval.
 *
 * State cleanup:
 *   - On result retrieval: wait() or init() deletes state and cancels alarm.
 *   - On expiration: alarm() deletes state (pending → expired; resolved → removed).
 *   - The alarm is always set (on init and on Case 3 reuse) and acts as the
 *     safety net — no state persists forever.
 */

interface State {
  secretId: string;
  session: string;
  status: "pending" | "approved" | "denied";
  callbackNonce: string;
  ip: string;
  createdAt: number;
  notifiedAt: number | null;
  expiresAt: number;
  /** Telegram chat ID. Null only before first notify() succeeds. */
  chatId: string | number | null;
  /** Telegram message ID. Null only before first notify() succeeds. */
  messageId: number | null;
  /** Secret value captured at init time. Included in approval result. */
  secret?: string;
}

const STATE_KEY = "state";

export class KeySessionDO extends DurableObject<Env> {
  private waitResolver: ((value: Approval) => void | Promise<void>) | null =
    null;

  /**
   * Initialize or recover a session.
   *
   * @param timeoutMs Effective timeout in milliseconds. Worker has already
   *     clamped any URL `?timeout=` to `[1000, maxMs]` (where `0` resolves
   *     to `maxMs`). Case 3 reuse recomputes `expiresAt` from this value,
   *     so each reconnect may set a fresh deadline.
   *
   * Three cases when a previous state exists:
   *  1. Already resolved (approved/denied) → return result immediately.
   *     Allows a disconnected client to retrieve a just-approved secret.
   *  2. Pending with an active listener → reject (409).
   *     Prevents multiple clients from silently receiving the same secret.
   *  3. Pending with no listener (client disconnected) → preserve state,
   *     update expiry from `timeoutMs`. If IP changed: revoke nonce,
   *     update IP, refresh Telegram message in-place.
   */
  async init(
    secretId: string,
    session: string,
    ip: string,
    secret?: string,
    timeoutMs?: number,
  ): Promise<Approval> {
    const effectiveTimeoutMs = timeoutMs ?? getMaxTimeoutMs(this.env);

    const existing = this.loadState();

    if (existing) {
      // Case 1: Already resolved — return immediately so a disconnected
      // client can retrieve a just-approved secret. Then clean up so
      // future requests trigger a fresh approval.
      if (existing.status !== "pending") {
        const approval = this.toApproval(existing);
        await this.ctx.storage.deleteAll();
        await this.cancelAlarm();
        return approval;
      }

      // Case 2: Pending with an active listener — reject to prevent
      // multiple clients from silently receiving the same secret on one
      // approval.
      if (this.waitResolver !== null) {
        throw new Error("Request already pending");
      }

      // Case 3: Pending but no listener (client disconnected).
      // Preserve the existing request; update expiry (from current URL
      // param) and optionally revoke the nonce if the IP changed.
      const now = Date.now();
      const expiresAt = now + effectiveTimeoutMs;

      if (existing.ip !== ip) {
        // IP changed — revoke nonce, update IP, refresh Telegram message.
        existing.callbackNonce = randomNonce();
        existing.ip = ip;
      }
      existing.secret = secret;
      existing.expiresAt = expiresAt;
      this.saveState(existing);
      await this.ctx.storage.setAlarm(expiresAt);

      // Refresh the Telegram message (updated IP/nonce/expiry).
      // If the message no longer exists or the edit fails, fall back to
      // a fresh notification. If that also fails, clean up — there's no
      // valid message for the admin to approve, so the client must not hang.
      let notified = false;
      if (existing.chatId && existing.messageId) {
        try {
          await refreshApprovalMessage(
            this.env.TELEGRAM_BOT_TOKEN,
            existing.chatId,
            existing.messageId,
            existing.secretId,
            existing.session,
            existing.ip,
            existing.callbackNonce,
            existing.expiresAt,
          );
          notified = true;
        } catch {
          // Message gone or edit failed — fall through to fresh notification.
        }
      }
      if (!notified) {
        try {
          await this.notify(existing);
        } catch {
          // Fresh notification also failed. The state is still valid
          // (alarm will clean up on expiry) and the old message may
          // still exist (refresh failed for a transient reason).
          // Log and continue — the client can retry.
          console.error("Failed to send fresh notification in Case 3");
        }
      }

      return this.toApproval(existing);
    }

    // New request (or fresh request after cleaning up an abandoned one)
    const callbackNonce = randomNonce();
    const now = Date.now();
    const expiresAt = now + effectiveTimeoutMs;
    const state: State = {
      secretId,
      session,
      status: "pending",
      callbackNonce,
      ip,
      createdAt: now,
      notifiedAt: null,
      expiresAt,
      chatId: null,
      messageId: null,
      secret,
    };

    this.saveState(state);
    await this.ctx.storage.setAlarm(expiresAt);
    try {
      await this.notify(state);
    } catch (err) {
      // Notification failed — clean up so the client gets an error
      // instead of a pending request the admin never sees.
      await this.ctx.storage.deleteAll();
      await this.cancelAlarm();
      throw err;
    }

    return this.toApproval(this.loadState()!);
  }

  /**
   * Approve a pending request. Validates the callback nonce.
   * Resolves the waiting wait() Promises. State persists until retrieved
   * via wait() or init(); the alarm handles cleanup if never retrieved.
   */
  async approve(
    callbackNonce: string,
  ): Promise<{ ok: boolean; error?: string; approval?: Approval }> {
    const state = this.loadState();
    if (!state) return { ok: false, error: "Session not found" };
    if (state.status !== "pending")
      return { ok: false, error: `Already ${state.status}` };
    if (state.callbackNonce !== callbackNonce)
      return { ok: false, error: "Invalid nonce" };

    state.status = "approved";
    this.saveState(state);
    const approval = await this.resolveWaiters(this.toApproval(state));

    return { ok: true, approval };
  }

  /**
   * Deny a pending request. Validates the callback nonce.
   * Resolves the waiting wait() Promises. State persists until retrieved
   * via wait() or init(); the alarm handles cleanup if never retrieved.
   */
  async deny(
    callbackNonce: string,
  ): Promise<{ ok: boolean; error?: string; approval?: Approval }> {
    const state = this.loadState();
    if (!state) return { ok: false, error: "Session not found" };
    if (state.status !== "pending")
      return { ok: false, error: `Already ${state.status}` };
    if (state.callbackNonce !== callbackNonce)
      return { ok: false, error: "Invalid nonce" };

    state.status = "denied";
    this.saveState(state);
    const approval = await this.resolveWaiters(this.toApproval(state));

    return { ok: true, approval };
  }

  /**
   * Long-poll: returns a Promise that resolves when the request is
   * approved, denied, or expired. The DO processes other RPC calls
   * (approve/deny) while this Promise is pending.
   */
  async wait(): Promise<Approval> {
    const state = this.loadState();
    if (!state) throw new Error("Session not found");
    if (state.status !== "pending") return this.toApproval(state);

    return new Promise<Approval>((resolve) => {
      this.waitResolver = async (approval) => {
        // Clean up DO after client retrieves the result
        await this.ctx.storage.deleteAll();
        await this.cancelAlarm();
        resolve(approval);
      };
    });
  }

  /**
   * Alarm handler — fires on timeout.
   *
   * If the request is still pending, marks it as expired and notifies
   * Telegram. If already resolved (approved/denied), just cleans up.
   * Always deletes all DO storage via deleteAll().
   */
  async alarm(): Promise<void> {
    const state = this.loadState();
    if (!state) {
      // No state (already cleaned up) — nothing to do
      return;
    }

    if (state.status === "pending") {
      // Still pending — mark as expired and update Telegram
      if (state.chatId != null && state.messageId != null) {
        try {
          await updateApprovalMessage(
            this.env.TELEGRAM_BOT_TOKEN,
            state.chatId,
            state.messageId,
            state.secretId,
            state.session,
            state.ip,
            "expired",
            state.expiresAt,
          );
        } catch {
          // Best-effort — ignore errors
        }
      }

      const approval: Approval = {
        ...this.toApproval(state),
        status: "expired",
      };
      await this.ctx.storage.deleteAll();
      await this.resolveWaiters(approval);
    } else {
      // Already resolved (approved/denied) — just clean up storage
      await this.ctx.storage.deleteAll();
    }
  }

  // --- Private helpers ---

  private loadState(): State | null {
    const raw = this.ctx.storage.kv.get<string>(STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as State;
  }

  private saveState(state: State): void {
    this.ctx.storage.kv.put(STATE_KEY, JSON.stringify(state));
  }

  private toApproval(state: State): Approval {
    return {
      secretId: state.secretId,
      session: state.session,
      status: state.status,
      callbackNonce: state.callbackNonce,
      ip: state.ip,
      createdAt: state.createdAt,
      notifiedAt: state.notifiedAt,
      expiresAt: state.expiresAt,
      chatId: state.chatId,
      messageId: state.messageId,
      secret: state.secret,
    };
  }

  /** Resolve all pending wait() Promises with the given approval. */
  private async resolveWaiters(approval: Approval): Promise<Approval> {
    if (this.waitResolver) {
      await this.waitResolver(approval);
      this.waitResolver = null;
    }
    return approval;
  }

  /** Cancel the alarm if one is set (best-effort). */
  private async cancelAlarm(): Promise<void> {
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // Alarm may not exist
    }
  }

  /**
   * Cancel a pending wait() when the client disconnects.
   * Clears the resolver so a subsequent init() sees no active listener
   * and allows the client to retry.
   */
  cancelWait(): void {
    this.waitResolver = null;
  }

  /** Send Telegram notification and store chatId/messageId in state. */
  private async notify(state: State): Promise<void> {
    try {
      const { messageId } = await sendApprovalMessage(
        this.env.TELEGRAM_BOT_TOKEN,
        this.env.TELEGRAM_CHAT_ID,
        state.secretId,
        state.session,
        state.ip,
        state.callbackNonce,
        state.expiresAt,
      );
      // Store message info for later updates (expiration, status)
      const current = this.loadState();
      if (current) {
        this.saveState({
          ...current,
          chatId: this.env.TELEGRAM_CHAT_ID,
          messageId,
          notifiedAt: Date.now(),
        });
      }
    } catch (err) {
      console.error("Failed to send Telegram notification:", err);
      throw err;
    }
  }
}
