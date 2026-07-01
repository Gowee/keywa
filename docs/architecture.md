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

## Why Durable Objects over KV Polling

The original implementation used KV to store approval state, with the worker polling KV every 5 seconds. This had three problems:

| Problem | KV Polling | Durable Objects |
|---------|-----------|-----------------|
| **Consistency** | KV has up to 60s eventual consistency. Approval might not be visible for a minute. | DO storage is strongly consistent. Approval is visible instantly. |
| **CPU cost** | 180 KV reads per 15-min request. Burns through free-tier quotas. | DO holds a Promise in memory. Zero reads while waiting. |
| **Complexity** | Polling loop with timeout logic, re-reads, state management. | Single `await stub.wait()` call. The DO resolves the Promise when approved. |

### The Long-Polling Pattern

The key insight is that a Durable Object can hold a Promise open across RPC calls:

```
Worker                          Durable Object
  │                                │
  ├─ stub.wait() ────────────────►│
  │   (returns Promise)            │ stores resolver in memory
  │   (Worker awaits)              │ (idle, no CPU)
  │                                │
  │  ... time passes ...           │
  │                                │
  ├─ stub.approve(token) ────────►│
  │                                │ calls resolver(approval)
  │◄───────────────────────────────┤
  │   wait() resolved!             │
  │   returns key to curl          │
```

The DO is free to process `approve()` while `wait()` is pending — RPC doesn't block the DO, only the caller. This is the canonical pattern for request-response coordination in Cloudflare Workers.

### Why Not WebSocket?

The client is `curl` in a Linux initrd. It speaks plain HTTP only. WebSocket requires browser-level support or a dedicated WS client, neither of which is available in this environment.

HTTP long-polling achieves the same result: the client blocks until the response arrives. `curl` handles this natively.

### Why Not KV with Short Polling?

Even with 2-3s polling intervals, KV's eventual consistency means there's always a window where the approval has been recorded but isn't visible yet. Durable Objects eliminate this entirely — the approval is in the DO's own storage, and the DO resolves the Promise directly.

## Why SQLite in the Durable Object

Cloudflare recommends SQLite-backed storage for Durable Objects (over the legacy KV API). Benefits:

- **Strongly consistent**: reads reflect the latest write immediately
- **Queryable**: SQL queries for listing, filtering, aggregating
- **Transactional**: `blockConcurrencyWhile()` ensures atomic initialization
- **Self-contained**: no external storage dependencies

The DO uses a single `approval` table with a composite primary key `(secret_id, request_id)`. Each row represents one secret request attempt.

## Why Telegram Callback Buttons (not URL Buttons)

The original implementation sent Telegram messages with URL buttons that opened a browser tab returning "Approved" as plain text. Problems:

- Requires a browser (not available on all devices)
- No confirmation feedback (user sees raw text)
- No deny option
- URL is guessable if token is weak

Inline callback buttons (`callback_data`) work entirely within Telegram:

- Tap Approve/Deny → Telegram sends callback to webhook → worker processes → Telegram shows toast confirmation
- No browser needed
- Can show "✅ Approved" or "✗ Denied" as inline feedback
- `callback_data` is never exposed to the user

## Authentication

keywa has two authentication methods for admin operations, serving different principals:

| | ADMIN_TOKEN | Telegram Login |
|---|---|---|
| **Who** | Machines / scripts | Humans |
| **How** | Static secret in env | Live approval via Telegram |
| **Where** | CLI, CI/CD, initrd | Browser |
| **Revocation** | Rotate the secret | Simply don't approve |
| **Use case** | Automation, initial setup | Day-to-day key management |

Both methods authenticate the same admin API endpoints. The middleware checks:
1. `Authorization: Bearer` header → compare against `ADMIN_TOKEN`
2. `Cookie: keywa_session` → verify signed JWT
3. Neither → reject with 401

### Telegram Login (Approval-Based)

The web admin login uses the same approval pattern as secret retrieval — no OAuth widget, no hash verification:

```
User visits /admin → clicks "Login"
  → Worker sends Telegram message "Login from IP x.x.x.x" with Approve button
  → Page long-polls (same DO pattern as secret retrieval)
  → User clicks Approve in Telegram
  → DO resolves, session cookie set, user logged in
```

This reuses the `KeySessionDO` with a special secretId prefix (`__auth__`) and no secret value. The approval itself IS the authentication — if you can approve in Telegram, you are the admin.

Session cookie: signed JWT stored in KV, 24h TTL, `HttpOnly Secure SameSite=Strict`.

## Threat Model

| Attack | Mitigation |
|--------|-----------|
| Attacker discovers a key ID | Per-key token required; knowing the ID alone is insufficient |
| Attacker replays a request | Each request gets a unique `approval_nonce`; expired requests auto-deny |
| Attacker forges a Telegram callback | `approvalNonce` is a UUID (122 bits); webhook secret optional defense-in-depth |
| Attacker brute-forces the key token | Rate limiting at the Worker level |
| VPS provider reads disk at rest | LUKS encryption (client-side concern, not keywa's) |
| Key leaked after approval | Keys are returned once; DO state expires via alarm |
| Attacker forges session cookie | JWT signed with `ADMIN_TOKEN`; tampering invalidates it |
| Attacker accesses web admin | Login requires Telegram approval; only the admin's Telegram account can approve |

## Data Flow

### Secret Management (Admin API)

```
Admin → PUT /admin/api/keys/:keyId (Bearer token or session cookie)
  → Worker stores { value, token } in KV

Admin → DELETE /admin/api/keys/:keyId
  → Worker removes from KV
```

### Secret Retrieval (Client)

```
Client → GET /secret/:keyId?token=KEY_TOKEN
  → Worker validates access token against KV
  → Worker gets DO stub for (secretId, session)
  → DO.init() → sends Telegram notification (if not already notified)
  → DO.wait() → blocks (Promise held in memory)
  ... admin clicks Approve in Telegram ...
  → Telegram → POST /telegram/webhook
  → Worker → DO.approve(approvalNonce)
  → DO resolves wait() Promise
  → Worker returns secret value to client
```

### Web Admin Login

```
Browser → GET /admin → login page
User clicks "Login" → POST /admin/auth/login
  → Worker creates DO session for __auth__/{nonce}
  → DO sends Telegram message "Login request from IP ..."
  → Page long-polls DO.wait()
  → Admin clicks Approve in Telegram
  → DO resolves, Worker sets session cookie
  → Browser redirects to /admin/dashboard
```

### Approval (Admin via Telegram)

```
Telegram → POST /telegram/webhook (callback_query)
  → Worker parses callback_data: "a:{approvalToken}" or "d:{approvalToken}"
  → Worker looks up DO name from KV mapping (cb:{approvalNonce})
  → Worker calls DO.approve(approvalNonce) or DO.deny(approvalNonce)
  → Worker calls answerCallbackQuery (shows toast in Telegram)
```
