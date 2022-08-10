export const notifier = (bot_token: string, chat_id: string | number) => {
  async function notify(message: string, url: string) {
    const params = {
      chat_id: chat_id,
      text: message,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "Approve", url: url }]] },
    };
    const req = fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const resp = await req;
    const res: any = await resp.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!res.ok) {
      console.error(resp, res);
      throw new Error("Failed to notify");
    }
  }
  return notify;
};

export const sleep = (ms: number) =>
  new Promise((res) => setTimeout(res, ms, undefined));
