/**
 * Telegram Bot API helpers for keywa.
 *
 * Uses inline callback buttons (not URL buttons) so approval happens
 * entirely within Telegram — no browser needed.
 *
 * callback_data format: "a:{approvalNonce}" or "d:{approvalNonce}"
 * where approvalNonce is a UUID (36 chars). Total: 39 bytes, fits in 64-byte limit.
 * The DO is already identified by the webhook routing (secretId + session encoded
 * in the message metadata via KV lookup), so callback_data only needs the action
 * and the approvalNonce for validation.
 */

const TELEGRAM_API = "https://api.telegram.org/bot";

/** Build callback_data string. */
export function buildCallbackData(
  action: "a" | "d",
  approvalNonce: string,
): string {
  return `${action}:${approvalNonce}`;
}

/** Parse callback_data back into its components. */
export function parseCallbackData(data: string): {
  action: "approve" | "deny";
  approvalNonce: string;
} | null {
  const colonIdx = data.indexOf(":");
  if (colonIdx === -1) return null;
  const action = data.slice(0, colonIdx);
  if (action !== "a" && action !== "d") return null;
  return {
    action: action === "a" ? "approve" : "deny",
    approvalNonce: data.slice(colonIdx + 1),
  };
}

/**
 * Send an approval request message with inline Approve/Deny buttons.
 * Also stores a mapping from approvalNonce → (secretId, session) in KV
 * so the webhook handler can find the right DO.
 */
export async function sendApprovalMessage(
  botToken: string,
  chatId: string | number,
  secretId: string,
  session: string,
  ip: string,
  approvalNonce: string,
  kv: KVNamespace,
): Promise<void> {
  const approveData = buildCallbackData("a", approvalNonce);
  const denyData = buildCallbackData("d", approvalNonce);

  // Store mapping: approvalNonce → (secretId, session) for webhook routing
  // Expire after 15 minutes (matching request timeout)
  await kv.put(
    `cb:${approvalNonce}`,
    JSON.stringify({ secretId, session, ip }),
    {
      expirationTtl: 900,
    },
  );

  const text = formatRequestMessage(secretId, session, ip);

  const resp = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
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
  user?: string,
): Promise<void> {
  const statusEmoji =
    status === "approved" ? "✅" : status === "denied" ? "❌" : "⏰";
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  // user is already MarkdownV2-formatted (with link), don't escape it
  const userLine = user ? ` by ${user}` : "";
  const text =
    formatRequestMessage(secretId, session, ip) +
    `\n\n${statusEmoji} *${escapeMarkdown(statusLabel)}*${userLine}`;

  await fetch(`${TELEGRAM_API}${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "MarkdownV2",
    }),
  });
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
): string {
  return [
    "🔐 *Approval Required*",
    "",
    `Secret:  \`${escapeMarkdown(secretId)}\``,
    `Session: \`${escapeMarkdown(session)}\``,
    `IP:      \`${escapeMarkdown(ip)}\``,
  ].join("\n");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
