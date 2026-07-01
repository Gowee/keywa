import { describe, it, expect } from "vitest";
import { buildCallbackData, parseCallbackData } from "../src/telegram";

describe("Telegram callback data", () => {
  it("round-trips approve action", () => {
    const nonce = "550e8400-e29b-41d4-a716-446655440000";
    const data = buildCallbackData("a", nonce);
    expect(data).toBe(`a:${nonce}`);
    expect(data.length).toBeLessThanOrEqual(64);

    const parsed = parseCallbackData(data);
    expect(parsed).toEqual({ action: "approve", approvalNonce: nonce });
  });

  it("round-trips deny action", () => {
    const nonce = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const data = buildCallbackData("d", nonce);
    expect(data).toBe(`d:${nonce}`);

    const parsed = parseCallbackData(data);
    expect(parsed).toEqual({ action: "deny", approvalNonce: nonce });
  });

  it("returns null for invalid data", () => {
    expect(parseCallbackData("")).toBeNull();
    expect(parseCallbackData("x:something")).toBeNull();
    expect(parseCallbackData("no-colon")).toBeNull();
  });

  it("fits within Telegram 64-byte callback_data limit", () => {
    const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    const data = buildCallbackData("a", uuid);
    expect(data.length).toBeLessThanOrEqual(64);
  });
});
