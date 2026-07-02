export interface Env {
  SECRETS: KVNamespace;
  KEY_SESSION_DO: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN: string;
  TIMEOUT_SECONDS?: string;
}

/** A secret stored in KV */
export interface StoredSecret {
  secret: string;
  token: string;
}

/** The state of an approval request, persisted in DO KV. */
export interface Approval {
  secretId: string;
  session: string;
  status: "pending" | "approved" | "denied" | "expired";
  callbackNonce: string;
  ip: string;
  createdAt: number;
  notifiedAt: number | null;
  expiresAt: number;
  chatId: string | number | null;
  messageId: number | null;
}

/** Get the timeout in milliseconds from env, defaulting to 900s (15 min). */
export function getTimeoutMs(env: { TIMEOUT_SECONDS?: string }): number {
  return (parseInt(env.TIMEOUT_SECONDS || "", 10) || 900) * 1000;
}

export const DEFAULT_SESSION = "default";
