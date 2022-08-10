import { sleep, notifier } from "./utils";

const TIMEOUT_IN_SECONDS = 15 * 60;
const POLL_INTERNAL_IN_SECONDS = 5;
const DEFAULT_SESSION_NAME = "default";

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

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string | number;
}

class ClientError extends Error {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1).split("/");
    const notify = notifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

    try {
      switch (path[0]) {
        case "key": {
          const ref = path[1];
          if (!ref) throw new ClientError("Key ref unspecified");
          const key = await env.KEYWA.get(ref);
          if (!key) throw new ClientError("Key ref invalid");
          const session = path[2] ?? DEFAULT_SESSION_NAME;
          const sid = `${ref}/session-${session}`;
          let state = JSON.parse((await env.KEYWA.get(sid)) || "null");
          const cip = request.headers.get("CF-Connecting-IP") ?? "Unknonwn";

          if (state) {
            console.log(
              "Recovered from saved state: ",
              sid,
              " last notified at: ",
              state?.notified_at
            );
          } else {
            console.debug("Initiate new session: ", sid);
            const token = crypto.randomUUID();
            state = {
              token,
              approved: false,
              notified_at: null,
            };
          }

          if (
            !state.approved &&
            (!state.notified_at ||
              Date.now() - +new Date(state.notified_at) >
                TIMEOUT_IN_SECONDS * 1000)
          ) {
            const aurl = new URL(
              `/approve/${ref}/${session}/${state.token}`,
              request.url
            ).toString();
            await notify(
              `🗝️ **Key Request**\nref: \`${ref}\`\nsession: \`${session}\`\nIP: \`${cip}\``,
              aurl
            );
            state.notified_at = new Date();
            await env.KEYWA.put(sid, JSON.stringify(state), {
              expirationTtl: TIMEOUT_IN_SECONDS,
            });
          }

          // Polling for approval. NOTE: KV may take up to 60 seconds to sychronize.
          const start = Date.now();
          while (Date.now() - start < TIMEOUT_IN_SECONDS * 1000) {
            if (state?.approved) {
              return new Response(key, {
                headers: { "Content-Type": "text/plain" },
              });
            }
            await sleep(POLL_INTERNAL_IN_SECONDS * 1000);
            state = JSON.parse((await env.KEYWA.get(sid)) || "null");
          }
          throw new Error("Timeout, try again");
        }

        case "approve": {
          const ref = path[1];
          if (!ref) throw new ClientError("Key ref unspecified");
          const session = path[2] ?? DEFAULT_SESSION_NAME;
          const sid = `${ref}/session-${session}`;
          const state = JSON.parse((await env.KEYWA.get(sid)) || "null");

          if (!state) throw new Error("Session invalid");
          if (state.token !== path[3]) throw new ClientError("Token invalid");
          if (state.approved) throw new ClientError("Already approved yet");

          state.approved = true;
          await env.KEYWA.put(sid, JSON.stringify(state), {
            expirationTtl: 2 * TIMEOUT_IN_SECONDS,
          });
          return new Response("Approved");
        }
        case "/":
          return new Response("Hollo Werld!");
        default:
          return new Response("Endpoint not found", { status: 404 });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.error(e?.stack);
      return new Response(e.toString(), {
        status: e instanceof ClientError ? 400 : 500,
      });
    }
  },
};
