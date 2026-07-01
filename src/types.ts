export interface Env {
  SECRETS: KVNamespace;
  KEY_SESSION_DO: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN: string;
}

/** A secret stored in KV */
export interface StoredSecret {
  secret: string;
  token: string;
}

/** The state of an approval request, persisted in DO SQLite */
export interface Approval {
  secretId: string;
  session: string;
  secretValue: string;
  status: "pending" | "approved" | "denied" | "expired";
  approvalNonce: string;
  ip: string;
  createdAt: number;
  notifiedAt: number | null;
}

export const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_SESSION = "default";
