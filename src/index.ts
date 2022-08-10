const TIMEOUT_IN_SECONDS = 15 * 60;
const POLL_INTERNAL_IN_SECONDS = 5;

declare global {
	const TELEGRAM_CHAT_ID: string;
	const TELEGRAM_BOT_TOKEN: string;
}

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	KEYWA: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;

	TELEGRAM_BOT_TOKEN: string,
	TELEGRAM_CHAT_ID: string | number
}

class ClientError extends Error { }

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		console.log(request);
		let url = new URL(request.url);
		let path = url.pathname.slice(1).split('/');
		const notify = notifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
		try {
			switch (path[0]) {
				case "key":
					{
						const ref = path[1];
						if (!ref) {
							throw new ClientError("Key ref unspecified");
						}
						const key = await env.KEYWA.get(ref);
						if (!key) {
							throw new ClientError("Key ref invalid");
						}
						const session = path[2] ?? "Unknown";
						const sid = `${ref}/session-${session}`;
						const state = JSON.parse(await env.KEYWA.get(sid) || "null");
						const cip = request.headers.get("CF-Connecting-IP") ?? "Unknonwn";
						if (state) {
							console.log("Recovered from saved state: ", sid);
							if (state.approved) {
								return new Response(key, { headers: { 'Content-Type': 'text/plain' } });
							}
							if (!state.notified_at || (Date.now() - +(new Date(state.notified_at)) > TIMEOUT_IN_SECONDS * 1000)) {
								const aurl = (new URL(`/approve/${ref}/${session}/${state.token}`, request.url)).toString();
								await notify(`🗝️ **Key Request**\nref: \`${ref}\`\nsession: \`${session}\`\nIP: \`${cip}\``, aurl);
								state.notified_at = new Date();
								await env.KEYWA.put(sid, JSON.stringify(state), { expirationTtl: TIMEOUT_IN_SECONDS });
							}
						}
						else {
							console.log("Initiate new session: ", sid);
							const token = crypto.randomUUID();
							const aurl = (new URL(`/approve/${ref}/${session}/${token}`, request.url)).toString();
							await notify(`🗝️ **Key Request**\nref: \`${ref}\`\nsession: \`${session}\`\nIP: \`${cip}\``, aurl);
							const state = {
								// session,
								// ip: cip,
								token,
								approved: false,
								notified_at: new Date(),
							};
							await env.KEYWA.put(sid, JSON.stringify(state), { expirationTtl: TIMEOUT_IN_SECONDS });
						}
						const start = Date.now();
						while (Date.now() - start < TIMEOUT_IN_SECONDS * 1000) {
							const state = JSON.parse(await env.KEYWA.get(sid) || "null");
							if (state?.approved) {
								return new Response(key, { headers: { 'Content-Type': 'text/plain' } });
							}
							await sleep(POLL_INTERNAL_IN_SECONDS * 1000);
						}
						throw new Error("Timeout, try again");
					}
				case "approve":
					{
						const ref = path[1];
						if (!ref) {
							throw new ClientError("Key ref unspecified");
						}
						const session = path[2] ?? "Unknown";
						const sid = `${ref}/session-${session}`;
						const state = JSON.parse(await env.KEYWA.get(sid) || "null");
						if (!state) {
							throw new Error("Session invalid");
						}
						if (state.token !== path[3]) {
							throw new ClientError("Token invalid")
						}
						if (state.approved) {
							throw new ClientError("Already approved yet");
						}
						state.approved = true;
						await env.KEYWA.put(sid, JSON.stringify(state), { expirationTtl: 2 * TIMEOUT_IN_SECONDS });
						return new Response("Approved");
					}
			}
		}
		catch (e: any) {
			console.error(e?.stack);
			if (e instanceof ClientError) {
				return new Response(e.toString(), { status: 400 })
			} else {
				return new Response(e.toString(), { status: 500 })
			}
		}
		return new Response("Hello World!");
	},
};

const notifier = (bot_token: string, chat_id: string | number) => {
	async function notify(message: string, url: string) {
		const params = {
			chat_id: chat_id,
			text: message,
			parse_mode: "MarkdownV2",
			reply_markup: { inline_keyboard: [[{ text: "Approve", url: url }]] }
		};
		console.log(params);
		const req = fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, { method: 'POST', headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
		const resp = await req;
		const res: any = await resp.json();
		if (!res.ok) {
			console.error(resp, res)
			throw new Error("Failed to notify")
		}
	}
	return notify;
}


const sleep = (ms: number) => new Promise(res => setTimeout(res, ms, undefined));
