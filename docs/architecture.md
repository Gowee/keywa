# Architecture

## Overview

keywa is a secret retrieval service that requires human approval via Telegram before releasing keys. It runs on Cloudflare Workers and is designed for headless servers (e.g., VPS initrd scripts) that need to fetch disk encryption keys at boot time.

## Problem Statement

A headless server reboots and needs its LUKS decryption key. The key must not be stored on disk (defeats the purpose of encryption). The server must request the key from a remote service, and a human must approve the release.

Requirements:
- **Blocking request**: `curl` sends GET, blocks until approved or timed out
- **Human approval**: admin receives a Telegram notification, clicks Approve or Deny
- **Per-secret auth**: each key has its own token; knowing the key ID alone is insufficient
- **Low latency**: approval should be reflected instantly (no polling delay)
- **Low cost**: no CPU burned while waiting

## Storage

```
D1 (DB):         secrets table (strongly consistent, SQL)
DO KV:           approval state (strongly consistent, single key "state")
Cookie:          login session (signed, no persistence)
```

No KV namespaces. All persistent storage is D1 or DO-local.

The DO uses KV storage (`ctx.storage.kv`) with a single key `"state"`. The secret value is never stored in the DO — the worker re-fetches from D1 after approval.

### D1 Schema

```sql
CREATE TABLE IF NOT EXISTS secrets (
  id         TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  token      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

D1 provides strongly consistent reads — no eventual consistency delay for the admin dashboard.

## Why Durable Objects over KV Polling

| Problem | KV Polling | Durable Objects |
|---------|-----------|-----------------|
| **Consistency** | KV has up to 60s eventual consistency. | DO storage is strongly consistent. |
| **CPU cost** | 180 KV reads per 15-min request. | DO holds a Promise in memory. Zero reads while waiting. |
| **Complexity** | Polling loop with timeout logic. | Single `await stub.wait()` call. |

### The Long-Polling Pattern

```
Worker                          Durable Object
  │                                │
  ├─ stub.wait() ────────────────►│
  │   (returns Promise)            │ stores resolver in memory
  │   (Worker awaits)              │ (idle, no CPU)
  │                                │
  │  ... time passes ...           │
  │                                │
  ├─ stub.approve(nonce) ────────►│
  │                                │ validates nonce, resolves Promise
  │                                │ deletes state from KV
  │◄───────────────────────────────┤
  │   wait() resolved!             │
  │   re-fetches secret from D1    │
  │   returns key to curl          │
```

## Naming & Identifiers

All identifiers use base64url encoding (no padding) for compactness. Hash and nonce are 128-bit.

### DO Name

```
doName = base64url(SHA-256(secretId + "\0" + session).slice(0, 16))
```

- 22 characters, 128-bit collision resistance
- Deterministic: same (secretId, session) always produces the same name
- `\0` delimiter is forbidden in both secretId and session (validated on input)
- The original secretId and session are stored in the DO's KV state for display

### Callback Nonce

```
callbackNonce = base64url(crypto.getRandomValues(new Uint8Array(16)))
```

- 22 characters, 128-bit entropy
- CSRF token for the Telegram callback
- Validated by the DO on approve/deny

### Callback Data

Telegram's `callback_data` field has a 64-byte limit:

```
callback_data = "a:{doName22}:{callbackNonce22}"   # approve (48 bytes)
                "d:{doName22}:{callbackNonce22}"   # deny (48 bytes)
```

The DO name hash is embedded directly, so the webhook routes to the correct DO without any KV lookup.

## DO State

The DO stores a single KV key `"state"` containing:

```json
{
  "secretId": "my-server-luks",
  "session": "boot-20260702",
  "status": "pending",
  "callbackNonce": "base64url-encoded-22chars",
  "ip": "203.0.113.42",
  "createdAt": 1751234567890,
  "notifiedAt": 1751234568000,
  "expiresAt": 1751235467890,
  "chatId": -100123456789,
  "messageId": 42
}
```

### DO Lifecycle

| Phase | Action |
|-------|--------|
| `init()` | Store state, set alarm, notify Telegram (captures chatId/messageId) |
| `wait()` | Hold Promise in memory (zero CPU) |
| `approve(nonce)` | Validate nonce → set status → resolve wait() → delete state |
| `deny(nonce)` | Validate nonce → set status → resolve wait() → delete state |
| `alarm()` | Update Telegram message (⏰ Expired) → resolve wait() → delete state |

**Re-request**: If `init()` is called for a pending (secretId, session), the timeout is refreshed (`setAlarm` replaces the existing alarm) and the Telegram notification is re-sent if expired.

**No secretValue in DO**: The worker fetches the secret from D1 before calling `init()`. After `wait()` resolves as approved, the worker re-fetches from D1. The DO never stores the actual secret.

## Telegram Message

The approval message includes an expiration timestamp:

```
🔑 Key Request

Secret:  my-server-luks
Session: boot-20260702
IP:      203.0.113.42
Expires: 2026-07-02 12:34 UTC

[✅ Approve] [❌ Deny]
```

On approval/denial, the message is updated to show the result. On expiration (alarm), the message is updated to show "⏰ Expired" — this is best-effort using stored chatId/messageId.

## Authentication

| | ADMIN_TOKEN | Telegram Login |
|---|---|---|
| **Who** | Machines / scripts | Humans |
| **How** | Static secret in env | Live approval via Telegram |
| **Where** | CLI, CI/CD, initrd | Browser |
| **Revocation** | Rotate the secret | Simply don't approve |

Both methods authenticate the same admin API endpoints:
1. `Authorization: Bearer` header → compare against `ADMIN_TOKEN`
2. `Cookie: keywa_session` → verify signed JWT (no server-side state)
3. Neither → reject with 401

Telegram login can be disabled via `DISABLE_TELEGRAM_LOGIN = "true"` env var. The web admin always accepts `ADMIN_TOKEN` as a fallback.

## Threat Model

| Attack | Mitigation |
|--------|-----------|
| Attacker discovers a key ID | Per-key token required |
| Attacker replays a request | 128-bit `callbackNonce`; expired requests auto-deny and clean up |
| Attacker forges a Telegram callback | 128-bit random nonce; webhook secret optional defense-in-depth |
| Attacker brute-forces the key token | Rate limiting: 10 req/60s per secretId+IP (Rate Limit API) |
| Key leaked after approval | Keys returned once; DO state deleted immediately after use |
| Attacker forges session cookie | JWT signed with `ADMIN_TOKEN`; no server-side state to steal |
| Attacker floods login endpoint | Rate limiting: 1 login/60s globally (Rate Limit API) |
| Attacker accesses web admin | Login requires Telegram approval (can be disabled via `DISABLE_TELEGRAM_LOGIN`) |

## Data Flow

### Secret Retrieval (Client)

```
Client → GET /secret/:secretId?token=KEY_TOKEN
  → Worker validates token against D1
  → Worker computes doName = base64url(SHA-256(secretId + "\0" + session)[0:16])
  → Worker gets DO stub by hash name
  → DO.init(secretId, session, ip)
      → stores state in DO KV, sets alarm, sends Telegram notification
  → DO.wait() → blocks (Promise held in memory)
  ... admin clicks Approve in Telegram ...
  → Telegram → POST /telegram/webhook
  → Worker parses callback_data: "{action}:{doName22}:{callbackNonce22}"
  → Worker gets DO stub by hash name (no lookup needed)
  → DO.approve(callbackNonce) → validates, resolves wait(), deletes state
  → Worker re-fetches secret from D1
  → Worker returns secret to client
```

### Approval (Admin via Telegram)

```
Telegram → POST /telegram/webhook (callback_query)
  → Worker parses callback_data: "{action}:{doName22}:{callbackNonce22}"
  → Worker gets DO stub by hash name
  → DO.approve(callbackNonce) or DO.deny(callbackNonce)
      → validates nonce, returns {ok, approval}
  → Worker updates Telegram message (shows result)
  → Worker answers callback query (shows toast)
```

### DO Expiration (Alarm)

```
Alarm fires → DO.alarm()
  → Updates Telegram message to show "⏰ Expired" (best-effort)
  → Resolves wait() with status "expired"
  → Deletes state from DO KV (self-cleanup)
  → Worker returns "Timeout" (408) to client
```
