import { describe, it, expect } from "vitest";
import { buildCallbackData, parseCallbackData } from "../src/telegram";
import { doName, randomNonce } from "../src/crypto";

describe("Telegram callback data", () => {
  it("round-trips approve action", async () => {
    const name = await doName("my-secret", "default");
    const nonce = randomNonce();
    const data = buildCallbackData("a", name, nonce);
    expect(data.length).toBeLessThanOrEqual(64);

    const parsed = parseCallbackData(data);
    expect(parsed).toEqual({ action: "approve", doName: name, callbackNonce: nonce });
  });

  it("round-trips deny action", async () => {
    const name = await doName("other-secret", "session-2");
    const nonce = randomNonce();
    const data = buildCallbackData("d", name, nonce);
    expect(data.length).toBeLessThanOrEqual(64);

    const parsed = parseCallbackData(data);
    expect(parsed).toEqual({ action: "deny", doName: name, callbackNonce: nonce });
  });

  it("returns null for invalid data", () => {
    expect(parseCallbackData("")).toBeNull();
    expect(parseCallbackData("x:something:else")).toBeNull();
    expect(parseCallbackData("no-colon")).toBeNull();
    expect(parseCallbackData("a:only-one")).toBeNull();
    expect(parseCallbackData("a::empty")).toBeNull();
    expect(parseCallbackData("a:hash:")).toBeNull();
  });

  it("fits within Telegram 64-byte callback_data limit", async () => {
    // Worst case: longest reasonable secretId/session still produces 22-char hash
    const name = await doName("a".repeat(128), "b".repeat(128));
    const nonce = randomNonce();
    const data = buildCallbackData("a", name, nonce);
    expect(data.length).toBeLessThanOrEqual(64);
  });
});

describe("Crypto utilities", () => {
  it("doName produces consistent results", async () => {
    const a = await doName("secret1", "sess1");
    const b = await doName("secret1", "sess1");
    expect(a).toBe(b);
  });

  it("doName produces different results for different inputs", async () => {
    const a = await doName("secret1", "sess1");
    const b = await doName("secret1", "sess2");
    const c = await doName("secret2", "sess1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("doName is 22 chars (base64url of 16 bytes)", async () => {
    const name = await doName("test", "default");
    expect(name).toHaveLength(22);
    // base64url chars only
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("randomNonce is 22 chars", () => {
    const nonce = randomNonce();
    expect(nonce).toHaveLength(22);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("randomNonce produces unique values", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => randomNonce()));
    expect(nonces.size).toBe(100);
  });
});
