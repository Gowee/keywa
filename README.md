[![CI Check](https://github.com/Gowee/flakes/actions/workflows/check.yml/badge.svg)](https://github.com/Gowee/keywa/actions/workflows/check.yml)

# Key with approval
A simple web service for retrieving keys with approval.

## Setup
```sh
git clone https://github.com/Gowee/keywa && cd keywa
yarn install
cp wrangler.toml.sample wrangler.toml
# fill the Telegram bot token and KV namespace ID as listed in wrangler.toml
yarn deploy
```

## Workflow
### Manage keys

- add key: `yarn key put KEY_REF KEY_VALUE`
- delete key: `yarn key delete KEY_REF`
- list keys: `yarn key list`

Where `KEY_REF` (reference or name of keys/secrets) can be arbitrary text, such as an uuid. It should be kept as a secret, since otherwise it would allow anyone to raise a request.

### Retrieve key with approval

`curl https://keywa.example.org/key/KEY_REF/SESSION_NAME`

Where `SESSION_NAME` is an optional identifier for the key request session.

The request would be blocked until it is approved. The default timeout is 15 minutes. It is possible to retrieve the previously approved key request with another `curl` request as long as the `SESSION_NAME` matches.

### Approve

Upon receiving a key request, the worker push an approval link to the specified Telegram chat.
