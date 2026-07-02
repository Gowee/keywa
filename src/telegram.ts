/**
 * Telegram Bot API helpers for keywa.
 *
 * Uses inline callback buttons (not URL buttons) so approval happens
 * entirely within Telegram — no browser needed.
 *
 * callback_data format: "a:{doName22}:{callbackNonce22}" or "d:{doName22}:{callbackNonce22}"
 * where doName = base64url(SHA-256(secretId+"\0"+session).slice(0,16)) and
 * callbackNonce = base64url(random 16 bytes). Total: 48 bytes, fits in 64-byte Telegram limit.
 *
 * The DO name is derived from the hash, so the webhook can route directly
 * to the DO without any KV lookup.
 */

import { doName } from "./crypto";

const TELEGRAM_API = "https://api.telegram.org/bot";

/** Build callback_data string. */
export function buildCallbackData(
  action: "a" | "d",
  doNameHash: string,
  callbackNonce: string,
): string {
  return `${action}:${doNameHash}:${callbackNonce}`;
}

/** Parse callback_data back into its components. */
export function parseCallbackData(data: string): {
  action: "approve" | "deny";
  doName: string;
  callbackNonce: string;
} | null {
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [action, name, nonce] = parts;
  if (action !== "a" && action !== "d") return null;
  if (!name || !nonce) return null;
  return {
    action: action === "a" ? "approve" : "deny",
    doName: name,
    callbackNonce: nonce,
  };
}

/**
 * Send an approval request message with inline Approve/Deny buttons.
 * The DO name hash is embedded in callback_data so the webhook can route
 * directly to the DO without any KV lookup.
 *
 * Returns the Telegram message_id for later updates.
 */
export async function sendApprovalMessage(
  botToken: string,
  chatId: string | number,
  secretId: string,
  session: string,
  ip: string,
  callbackNonce: string,
  expiresAt: number,
): Promise<{ messageId: number }> {
  const name = await doName(secretId, session);
  const approveData = buildCallbackData("a", name, callbackNonce);
  const denyData = buildCallbackData("d", name, callbackNonce);

  const text = formatRequestMessage(secretId, session, ip, expiresAt);

  const resp = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: approveData },
            { text: "❌ Deny", callback_data: denyData },
          ],
        ],
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram sendMessage failed: ${resp.status} ${body}`);
  }

  const result = (await resp.json()) as { ok: boolean; result: { message_id: number } };
  return { messageId: result.result.message_id };
}

/**
 * Update the Telegram message to show the approval result.
 * Removes inline buttons and appends the status.
 */
export async function updateApprovalMessage(
  botToken: string,
  chatId: string | number,
  messageId: number,
  secretId: string,
  session: string,
  ip: string,
  status: "approved" | "denied" | "expired",
  expiresAt?: number,
  user?: string,
): Promise<void> {
  const statusEmoji =
    status === "approved" ? "✅" : status === "denied" ? "❌" : "⏰";
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const userLine = user ? ` by ${user}` : "";
  const text =
    formatRequestMessage(secretId, session, ip, expiresAt) +
    `\n\n${statusEmoji} <b>${escapeHtml(statusLabel)}</b>${userLine}`;

  const resp = await fetch(`${TELEGRAM_API}${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Telegram editMessageText failed: ${resp.status} ${body}`);
  }
}

/** Answer a callback query to dismiss the loading spinner and show a toast. */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(`${TELEGRAM_API}${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }),
  });
}

/** Register the webhook URL with Telegram. */
export async function registerWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
): Promise<{ ok: boolean; description?: string }> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["callback_query"],
  };
  if (secretToken) body.secret_token = secretToken;
  const resp = await fetch(`${TELEGRAM_API}${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await resp.json()) as { ok: boolean; description?: string };
  return result;
}

// --- Helpers ---

function formatRequestMessage(
  secretId: string,
  session: string,
  ip: string,
  expiresAt?: number,
): string {
  const lines = [
    "🔑 <b>Key Request</b>",
    "",
    `Secret:  <code>${escapeHtml(secretId)}</code>`,
    `Session: <code>${escapeHtml(session)}</code>`,
    `IP:      <code>${escapeHtml(ip)}</code>`,
  ];
  if (expiresAt) {
    lines.push(`Expires: <code>${escapeHtml(formatUTC(expiresAt))}</code>`);
  }
  return lines.join("\n");
}

function formatUTC(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format a Telegram user as an HTML link.
 * Only ASCII-safe names get linked; non-ASCII names are shown as plain text.
 */
export function formatTelegramUser(from?: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): string | undefined {
  if (!from) return undefined;

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const label = name || from.username || String(from.id);

  return `<a href="tg://user?id=${from.id}">${escapeHtml(label)}</a>`;
}
