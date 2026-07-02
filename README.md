# keywa

A secret retrieval service that requires human approval via Telegram. Built on Cloudflare Workers with Durable Objects.

Designed for headless servers (VPS, bare metal) that need to fetch sensitive secrets (e.g., LUKS disk encryption keys) at boot time via `curl`.

## How It Works

```
curl GET /secret/mysecret?token=credential → blocks → Telegram notification with Approve/Deny
                                              → admin clicks Approve → curl returns the secret
```

1. Client (`curl`) requests a secret by ID, providing a per-secret access token
2. keywa sends a Telegram notification with inline Approve/Deny buttons
3. `curl` blocks (HTTP long-polling) until the admin acts
4. Admin clicks Approve → secret is returned to `curl`
5. Or: admin clicks Deny → `curl` gets 403, or timeout after 15 min → 408

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

### 3. Deploy

```bash
pnpm deploy
```

### 4. Register Telegram Webhook

```bash
curl -X POST https://keywa.example.org/admin/webhook \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Usage

### Manage Secrets

```bash
# Add a secret (value + per-secret access token)
curl -X PUT https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secret": "luks-passphrase", "token": "per-secret-credential"}'

# Delete a secret
curl -X DELETE https://keywa.example.org/admin/api/secrets/mysecret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Retrieve a Secret (with Approval)

```bash
# This blocks until approved, denied, or timed out (15 min)
curl "https://keywa.example.org/secret/mysecret?token=per-secret-credential"

# Or via Bearer header
curl -H "Authorization: Bearer per-secret-token" "https://keywa.example.org/secret/mysecret"
```

With a named session (for idempotent re-fetching):

```bash
curl "https://keywa.example.org/secret/mysecret/my-session?token=per-secret-credential"
```

### Web Admin

Visit `/admin` in a browser. Login is approval-based — same as secret retrieval:

1. Click "Login with Telegram"
2. Approve the notification in Telegram
3. You're in

The dashboard lets you list, add, edit, and delete secrets.

### Example: Initrd Unlock Script

```bash
#!/bin/sh
# /etc/keyserver-unlock.sh — runs in NixOS initrd after SSH login

KEYSERVER="https://keywa.example.org"
SECRET_ID="tyo2-luks"
SECRET_AUTH="per-secret-credential"
DEVICE="/dev/vda2"

echo "Fetching LUKS key..."
SECRET=$(curl -sf --max-time 900 --retry 3 \
  "$KEYSERVER/secret/$SECRET_ID?token=$SECRET_AUTH")

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
| GET | `/secret/:secretId` | `?token=` or `Bearer` | Request secret (long-poll until approved) |
| GET | `/secret/:secretId/:session` | `?token=` or `Bearer` | Same, with explicit session name |
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
| PUT | `/admin/api/secrets/:secretId` | Add/update secret (`{secret, token}` body) |
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

## Architecture

See [docs/architecture.md](docs/architecture.md) for:

- Why Durable Objects over KV polling
- The HTTP long-polling pattern
- Authentication model (admin API key vs Telegram login)
- Threat model and security considerations

## License

MIT
