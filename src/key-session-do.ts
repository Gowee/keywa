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
 * Storage: a single KV key "state" containing the request state as JSON.
 * No secretValue is stored — the worker re-fetches from KV (SECRETS) after approval.
 *
 * Lifecycle:
 *   init()    → store state, set alarm, notify Telegram
 *   wait()    → hold Promise in memory
 *   approve() → validate nonce, resolve wait(), delete state
 *   deny()    → validate nonce, resolve wait(), delete state
 *   alarm()   → update Telegram message (expired), resolve wait(), delete state
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
}

const STATE_KEY = "state";

export class KeySessionDO extends DurableObject<Env> {
  private waitResolver: ((value: Approval) => void) | null = null;

  /**
   * Initialize or recover a session.
   * Sends a Telegram notification if this is a fresh request or the previous
   * notification has expired. Re-requesting a pending session refreshes the timeout.
   */
  async init(
    secretId: string,
    session: string,
    ip: string,
  ): Promise<Approval> {
    const existing = this.loadState();
    const timeoutMs = getTimeoutMs(this.env);

    if (existing) {
      // Already resolved — return immediately
      if (existing.status !== "pending") {
        return this.toApproval(existing);
      }

      // Pending and recently notified — refresh alarm, return
      if (
        existing.notifiedAt &&
        Date.now() - existing.notifiedAt < timeoutMs
      ) {
        const expiresAt = Date.now() + timeoutMs;
        this.saveState({ ...existing, expiresAt });
        await this.ctx.storage.setAlarm(expiresAt);
        return this.toApproval({ ...existing, expiresAt });
      }

      // Pending but notification expired — re-notify and refresh alarm
      const expiresAt = Date.now() + timeoutMs;
      const refreshed = { ...existing, expiresAt, notifiedAt: Date.now() };
      this.saveState(refreshed);
      await this.ctx.storage.setAlarm(expiresAt);
      await this.notify(refreshed);
      return this.toApproval(this.loadState()!);
    }

    // New request
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
    };

    this.saveState(state);
    await this.ctx.storage.setAlarm(expiresAt);
    await this.notify(state);

    return this.toApproval(this.loadState()!);
  }

  /**
   * Approve a pending request. Validates the callback nonce.
   * Resolves the waiting wait() Promise and cleans up KV state.
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
    const approval = this.resolveWait();

    return { ok: true, approval };
  }

  /**
   * Deny a pending request. Validates the callback nonce.
   * Resolves the waiting wait() Promise and cleans up KV state.
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
    const approval = this.resolveWait();

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
      this.waitResolver = resolve;
    });
  }

  /**
   * Alarm handler — fires on timeout.
   * Updates Telegram message to show expiration, resolves wait(), cleans up.
   */
  async alarm(): Promise<void> {
    const state = this.loadState();
    if (!state) return;

    // Best-effort: update Telegram message to show expired
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

    // Resolve wait() with expired status, then clean up
    const approval: Approval = {
      ...state,
      status: "expired",
      expiresAt: state.expiresAt,
    };
    this.ctx.storage.kv.delete(STATE_KEY);

    if (this.waitResolver) {
      this.waitResolver(approval);
      this.waitResolver = null;
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
    };
  }

  /** Resolve the pending wait() Promise and clean up KV state. */
  private resolveWait(): Approval {
    const state = this.loadState()!;
    const approval = this.toApproval(state);
    this.ctx.storage.kv.delete(STATE_KEY);

    if (this.waitResolver) {
      this.waitResolver(approval);
      this.waitResolver = null;
    }
    return approval;
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
