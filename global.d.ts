const TELEGRAM_CHAT_ID: string;
const TELEGRAM_BOT_TOKEN: string;

interface Env {
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

class ClientError extends Error { }
