import { DurableObject } from "cloudflare:workers";
import type { Approval } from "./types";
import { getTimeoutMs } from "./types";
import { sendApprovalMessage, updateApprovalMessage } from "./telegram";
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
 *   init()    → store state, set alarm, notify Telegram; or return resolved result and clean up
 *   wait()    → hold Promise in memory; on resolve → clean up state, cancel alarm
 *   approve() → validate nonce, resolve wait()
 *   deny()    → validate nonce, resolve wait()
 *   alarm()   → clean up state and resolve pending waiters
 *
 * Duplicate-request policy:
 *   - If there is an active listener (waitResolvers.length > 0), a new init()
 *     is rejected with "Request already pending" to prevent multiple clients
 *     from silently receiving the same secret on one approval.
 *   - If the previous client disconnected (no listeners but state is still
 *     pending), the abandoned request is cleaned up and a new request is
 *     created with a fresh notification.
 *   - If the request was already resolved (approved/denied), init() returns
 *     the result immediately and cleans up the DO. Future requests to the
 *     same (secretId, session) trigger a fresh approval.
 *
 * State cleanup:
 *   - On result retrieval: wait() or init() deletes state and cancels alarm.
 *   - On expiration: alarm() deletes state (pending → expired; resolved → removed).
 *   - No state persists forever.
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
  chatId: string | number | null;
  messageId: number | null;
  /** Secret value captured at init time. Included in approval result. */
  secret?: string;
}

const STATE_KEY = "state";

export class KeySessionDO extends DurableObject<Env> {
  private waitResolvers: ((value: Approval) => void | Promise<void>)[] = [];

  /**
   * Initialize or recover a session.
   *
   * Three cases when a previous state exists:
   *  1. Already resolved (approved/denied) → return result immediately.
   *     Allows a disconnected client to retrieve a just-approved secret.
   *  2. Pending with an active listener → reject (409).
   *     Prevents multiple clients from silently receiving the same secret.
   *  3. Pending with no listener (client disconnected) → clean up the
   *     abandoned request and create a new one with a fresh notification.
   */
  async init(secretId: string, session: string, ip: string, secret?: string): Promise<Approval> {
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
      if (this.waitResolvers.length > 0) {
        throw new Error("Request already pending");
      }

      // Case 3: Pending but no listener (client disconnected) — the
      // previous request is abandoned. Clean up and fall through to
      // create a fresh request with a new notification.
      await this.ctx.storage.deleteAll();
    }

    // New request (or fresh request after cleaning up an abandoned one)
    const timeoutMs = getTimeoutMs(this.env);
    const callbackNonce = randomNonce();
    const now = Date.now();
    const expiresAt = now + timeoutMs;
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
    await this.notify(state);

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
      this.waitResolvers.push(async (approval) => {
        // Clean up DO after client retrieves the result
        await this.ctx.storage.deleteAll();
        await this.cancelAlarm();
        resolve(approval);
      });
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
    for (const resolve of this.waitResolvers) {
      await resolve(approval);
    }
    this.waitResolvers = [];
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
    }
  }
}
