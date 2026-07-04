# keywa

A secret retrieval service that requires human approval via Telegram. Built on Cloudflare Workers with Durable Objects.

Designed for headless servers (VPS, bare metal) that need to fetch sensitive secrets (e.g., LUKS disk encryption keys) at boot time via `curl`.

## How It Works

```
curl GET /secret/mysecret?token=credential → blocks → Telegram notification with Approve/Deny
                                              → admin clicks Approve → curl returns the secret
```

1. Client (`curl`) requests a secret by ID, providing a per-secret access token
2. keywa checks IP allowlist (if configured) and token (if configured)
3. keywa sends a Telegram notification with inline Approve/Deny buttons
4. `curl` blocks (HTTP long-polling) until the admin acts
5. Admin clicks Approve → secret is returned to `curl`
6. Or: admin clicks Deny → `curl` gets 403, or timeout (default 1 hour) → 504

See [docs/architecture.md](docs/architecture.md) for design decisions and why Durable Objects over KV polling.

## Setup

### Prerequisites

- [pnpm](https://pnpm.io/)
- Cloudflare account with Workers enabled
- A Telegram bot (create via [@BotFather](https://t.me/BotFather))

### 1. Install & Configure

```bash
git clone https://github.com/Gowee/keywa && cd keywa
pnpm install
cp wrangler.toml.sample wrangler.toml
```

Edit `wrangler.toml` and fill in your D1 database ID:

```bash
pnpm wrangler d1 create keywa
# Copy the database_id into wrangler.toml
```

### 2. Set Secrets

```bash
echo "YOUR_BOT_TOKEN" | pnpm wrangler secret put TELEGRAM_BOT_TOKEN
echo "YOUR_CHAT_ID" | pnpm wrangler secret put TELEGRAM_CHAT_ID
echo "your-admin-api-key" | pnpm wrangler secret put ADMIN_TOKEN

# Optional: verify Telegram webhook requests (defense-in-depth)
echo "some-random-secret" | pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### 3. Optional Configuration

In `wrangler.toml`:

```toml
[vars]
TIMEOUT_SECONDS = "3600"               # approval timeout (default 1 hour)
# DISABLE_TELEGRAM_LOGIN = "true"      # uncomment to disable Telegram login
```

Rate limits are configured via `[[ratelimits]]` bindings (see `wrangler.toml.sample`).

### 4. Deploy

```bash
pnpm deploy
```

### 5. Register Telegram Webhook

```bash
curl -X POST https://keywa.example.org/admin/webhook \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Usage

### Manage Secrets

```bash
# Add a secret (value + per-secret access token and/or IP allowlist)
curl -X PUT https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secret": "luks-passphrase", "token": "per-secret-credential", "cidrs": "203.0.113.0/24"}'

# Update just the value (keep existing token and IPs)
curl -X PUT https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secret": "new-passphrase"}'

# Clear IP restriction (empty string = clear)
curl -X PUT https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cidrs": ""}'

# Delete a secret
curl -X DELETE https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Retrieve a Secret (with Approval)

```bash
# This blocks until approved, denied, or timed out (default 1 hour)

# Via query param
curl "https://keywa.example.org/secret/mysecret?token=per-secret-credential"

# Or via Bearer header
curl -H "Authorization: Bearer per-secret-credential" "https://keywa.example.org/secret/mysecret"
```

With a named session (for idempotent re-fetching):

```bash
curl -H "Authorization: Bearer per-secret-credential" "https://keywa.example.org/secret/mysecret?session=my-session"
```

### Web Admin

Visit `/admin` in a browser. Login via Telegram approval or admin token:

1. Click "Login with Telegram" → approve the notification
2. Or enter `ADMIN_TOKEN` directly

The dashboard lets you list, add, edit, and delete secrets. Telegram login can be disabled by setting `DISABLE_TELEGRAM_LOGIN = "true"` in `wrangler.toml`.

### Example: Initrd Unlock Script

```bash
#!/bin/sh
# /etc/keyserver-unlock.sh — runs in NixOS initrd after SSH login

KEYSERVER="https://keywa.example.org"
SECRET_ID="tyo2-luks"
SECRET_TOKEN="per-secret-credential"
DEVICE="/dev/vda2"

echo "Fetching LUKS key..."
SECRET=$(curl -fsSH "Authorization: Bearer $SECRET_TOKEN" \
  --max-time 3600 --retry 3 \
  "$KEYSERVER/secret/$SECRET_ID?session=boot")

if [ -z "$SECRET" ]; then
  echo "Failed to fetch secret"
  exit 1
fi

echo -n "$SECRET" | cryptsetup open "$DEVICE" crypted --key-file -
echo "✓ Disk unlocked. Continuing boot."
exit 0
```

## API Reference

### Public Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/secret/:secretId` | `?token=` or `Bearer` | Request secret (long-poll). Optional `?session=` |
| GET | `/` | — | Health check |

### Web Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin` | — | Login page (or redirect if session exists) |
| GET | `/admin/dashboard` | session cookie | Admin dashboard |
| POST | `/admin/auth/login` | — | Start login (long-poll for Telegram approval) |
| POST | `/admin/auth/logout` | session cookie | Clear session |

### Admin API

All admin endpoints accept either `Authorization: Bearer $ADMIN_TOKEN` or a session cookie (from web login).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/secrets` | List secrets (JSON) |
| PUT | `/admin/api/secrets/:secretId` | Add/update secret (`{secret, token, cidrs}` body) |
| DELETE | `/admin/api/secrets/:secretId` | Delete secret |
| POST | `/admin/webhook` | Register Telegram webhook |

### Telegram Webhook

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` | Receives Telegram callback queries |

## Development

```bash
pnpm dev         # local development with wrangler
pnpm build       # type-check and build
pnpm lint        # format check
pnpm test        # run tests
pnpm test:watch  # run tests in watch mode
```

### Export D1 Data

```bash
pnpm wrangler d1 export keywa --remote --output=backup.sql
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for:

- Why Durable Objects over KV polling
- The HTTP long-polling pattern
- Authentication model (admin API key vs Telegram login)
- Threat model and security considerations

## License

MIT
