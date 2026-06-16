# Hermes Wallet Gateway

A small, reusable **SIWE wallet-gate** you put in front of a stock
[Hermes agent](https://github.com/nousresearch/hermes-agent) dashboard. Visitors sign in with
their Ethereum wallet (Sign-In-With-Ethereum / EIP-4361); the gateway verifies the signature,
checks an address **allowlist**, sets a signed session cookie, and only then reverse-proxies them
to the dashboard. Built for **Oasis ROFL** (TDX TEE) but runs on any Docker host.

The Hermes image is **never modified** — the gateway sits in front of the stock dashboard, so
upgrading Hermes is just bumping its image tag/digest.

> **This repo is the gateway *component*, not a deployment.** It publishes the gateway image; you
> consume that image from your own Hermes deployment repo (which holds the `compose.yaml` and the
> `rofl.yaml` that `oasis rofl init` generates). See **[Using it](#using-it)**.

Full design rationale (in-tree-plugin alternative, Sapphire confidential-allowlist upgrade) is in
[`docs/architecture.md`](./docs/architecture.md).

## Architecture

```
Internet --HTTPS--> ROFL port proxy (TLS in TEE) --> wallet-gateway  ← THIS REPO publishes this
                                                       |  SIWE + allowlist + session cookie
                                                       |  reverse-proxy + WebSocket passthrough
                                                       v
                                              hermes-dashboard  (stock image, internal net,
                                                                 no public port)
                                              hermes-gateway    (stock image, agent runtime)
```

- **wallet-gateway** (Node + [viem](https://viem.sh)) — the only public service; does the SIWE
  handshake, allowlist check, signed cookie, and transparently proxies authenticated traffic
  (incl. WebSockets) to Hermes.
- **hermes-dashboard / hermes-gateway** — stock published image with no published port; the
  gateway is the only thing that can reach them.
- **ROFL port proxy** terminates TLS *inside the TEE* and hands you a public HTTPS URL — no
  Caddy/Traefik needed.

## Using it

**One published image serves every deployment.** Chain id and WalletConnect project are injected
into the login app at **runtime** (the gateway writes `window.__HERMES_GATE__` into the served
`index.html`), so you configure with env vars — **no rebuild per deployment**.

### 1. Point your deployment at the image

Copy [`compose.yaml`](./compose.yaml) into your deployment repo. It already references the prebuilt
public image `ghcr.io/rube-de/hermes-wallet-gateway:latest` (override with `GATEWAY_IMAGE=…`) and
runs the two stock Hermes services with no published port. Set the runtime config (see
[Configuration](#configuration)) via env / ROFL secrets, then **[deploy](#deploying-on-rofl)**.

### 2. (Optional) Build & push your own image

Only needed if you **fork the gateway code** — not to change WalletConnect project or chain (those
are runtime). With [`just`](https://github.com/casey/just):

```bash
GATEWAY_IMAGE=ghcr.io/<your-org>/hermes-wallet-gateway:0.1.0 just push
```

or directly:

```bash
# linux/amd64 is required for ROFL; --provenance=false keeps a clean single-arch
# manifest. The Dockerfile builds the React app on the NATIVE builder arch, so
# this cross-build is fast even on Apple Silicon.
docker buildx build --platform linux/amd64 --provenance=false \
  -f gateway/Dockerfile -t ghcr.io/<your-org>/hermes-wallet-gateway:0.1.0 --push .
```

Then make the package **public** — ROFL cannot pull private images (it has no registry-credential
mechanism): GitHub → Packages → your package → *Change visibility → Public*.

## Configuration

| Var | Phase | Set via | Purpose |
|-----|-------|---------|---------|
| `WALLET_WHITELIST` | run | env / ROFL secret | Comma-separated allowed `0x` addresses. |
| `WALLET_SESSION_SECRET` | run | env / ROFL secret | HMAC key for session cookies (`openssl rand -hex 32`). |
| `WALLET_DOMAIN` | run | env / ROFL secret | Public host(s) SIWE binds to. Comma-separated set allowed. |
| `WALLET_CHAIN_ID` | run | env | Chain the gateway verifies **and** injects into the login app. |
| `WALLET_WC_PROJECT_ID` | run | env | WalletConnect/Reown project id (mobile/QR), injected into the login app. Empty = WalletConnect off (injected wallets still work). |
| `WALLET_SESSION_TTL` | run | env | Session lifetime in seconds (default 43200 = 12h). |
| `HERMES_TARGET` | run | env | Upstream dashboard URL (`http://hermes-dashboard:9119`). |
| `COOKIE_SECURE` | run | env | `true` in prod (HTTPS); `false` only for local http. |
| `VITE_WC_PROJECT_ID` / `VITE_CHAIN_ID` | build | `--build-arg` | **Fallback only** for `npm run dev` (no gateway in front). The runtime vars above take precedence. |

The login app reads runtime config first, then the baked `VITE_*` fallback, then defaults — so a
plain `npm run dev` still works, and a deployed image is fully configured by env.

## Local development

Run the gateway against a mock upstream — no Hermes image, no API keys, no wallet extension needed.

```bash
just dev                 # http://127.0.0.1:8080  (gateway + mock dashboard)
just dev wc=<reown-id>   # ...with WalletConnect/mobile QR enabled
```

Set the allowlist with `WALLET_WHITELIST=0xYourAddress just dev`. `compose.local.yml` accepts both
`localhost:8080` and `127.0.0.1:8080` as SIWE domains (they're separate browser origins). Headless
check (no browser): `just smoke`. Typecheck the login app: `just check`.

Without `just`: `WALLET_WHITELIST=0xYourAddress docker compose -f compose.local.yml up --build`.
If the login app isn't built, the gateway serves a dependency-free fallback page (injected wallets
only) so it still works.

## Deploying on ROFL

Do this from your **deployment repo** (this one only publishes the image). Prereqs: the
[Oasis CLI](https://docs.oasis.io/build/tools/cli/), a funded account, and Docker. The gateway
image and the Hermes images are all public.

```bash
oasis rofl init                       # generates rofl.yaml (set resources: mem 4096, cpus 2, disk 20000+)
oasis rofl create --network testnet   # registers an app id on Sapphire
oasis rofl build                      # validates compose + packs the bundle (images must be public)

# secrets — encrypted into the manifest, only decrypt inside the attested TEE:
openssl rand -hex 32 | tr -d '\n'       | oasis rofl secret set WALLET_SESSION_SECRET -
echo -n "0xAddr1,0xAddr2"               | oasis rofl secret set WALLET_WHITELIST -
echo -n "placeholder.invalid"           | oasis rofl secret set WALLET_DOMAIN -   # real host known only after deploy

oasis rofl update                     # REQUIRED before deploy (pushes policy + secrets on-chain)
oasis rofl deploy                     # rents a TDX machine and runs it

# bind SIWE to the real proxy host (only known after the first deploy):
oasis rofl machine show               # -> https://p8080.m<id>.<...>.rofl.app
echo -n "p8080.m<id>.<...>.rofl.app"  | oasis rofl secret set WALLET_DOMAIN -
oasis rofl update
```

`WALLET_DOMAIN` accepts a comma-separated set, so you can pre-seed a custom domain alongside the
generated `*.rofl.app` host. Custom domain: point a DNS `A` + `TXT` record at the proxy per the
[port-proxy docs](https://docs.oasis.io/build/rofl/features/proxy/).

> Hermes needs at least one LLM provider key to actually *function* — it boots without one (so the
> wallet gate is testable), but the agent is inert until you seed `~/.hermes/.env` / run its `setup`.

## Managing the allowlist

```bash
echo -n "0xAddr1,0xAddr2,0xAddr3" | oasis rofl secret set WALLET_WHITELIST -
oasis rofl update
```

Removing an address takes effect on **new** logins immediately, but an already-issued session cookie
stays valid until it expires (`WALLET_SESSION_TTL`, default 12h). Lower the TTL for tighter
revocation, or re-check the allowlist per request (a one-line change in `siwe.ts`/`server.ts`).

## Security notes

- **EOA wallets only** in v1. Smart-contract / account-abstraction wallets (Safe, ERC-4337) need
  EIP-1271 — a fast-follow that swaps `recoverMessageAddress` for viem's `verifySiweMessage` with a
  public client.
- **Single gateway replica** assumed: the SIWE nonce store is in-memory. Scale-out needs a shared
  store (Redis `SETEX` + atomic `GETDEL`).
- Replay protection is the **server-issued single-use nonce**, domain-binding is pinned from
  `WALLET_DOMAIN` (not a client header), the verify endpoint returns a generic 401 (no
  allowlist-vs-signature oracle), and the session cookie is `HttpOnly`/`SameSite=Lax`/`Secure`
  HMAC-signed.
- `http-proxy` is battle-tested but in maintenance mode; `http-proxy-3` is a drop-in maintained fork
  if you prefer.

## Upgrade path

The whitelist backend is one function (`isAllowed` in `gateway/src/siwe.ts`). Swap it for a DB
table, ERC-721/1155 token-gating, or — to keep the roster **private and on-chain** — an Oasis
**Sapphire confidential** allowlist queried with a TEE-derived key (gate the read path so membership
can't be probed). See [`docs/architecture.md`](./docs/architecture.md), §5.

## Layout

```
login-app/          RainbowKit + wagmi login page (Vite/React) — injected + WalletConnect/mobile
  src/App.tsx       Connect + SIWE sign-in flow
  src/main.tsx      wagmi/RainbowKit providers
  src/runtime.ts    reads window.__HERMES_GATE__ (gateway-injected chain id + WC project)
gateway/            the wallet-auth reverse proxy (Node, runs .ts directly via type-stripping)
  src/server.ts     http server: SIWE routes + serves the login app + gated reverse proxy + WS
  src/siwe.ts       nonce store + EIP-4361 verify + allowlist (isAllowed)
  src/session.ts    stateless HMAC-signed session cookie
  src/static.ts     serves login-app/dist + injects runtime config into index.html
  src/config.ts     env-driven config
  src/login-page.ts dependency-free fallback page (used only if login-app isn't built)
  Dockerfile        multi-stage build (native login-app build + amd64 runtime)
compose.yaml        reference: gateway (published) + 2 stock Hermes services (internal) — copy to your deploy repo
compose.local.yml   local smoke stack: gateway + mock upstream
justfile            build / push / dev / smoke / check recipes
docs/architecture.md  full design rationale
```

`rofl.yaml` is **not** in this repo — it's generated by `oasis rofl init` (and filled in by
`oasis rofl create`/`update` with your app id, enclave hashes, and deployments). It's
deployment-specific and gitignored.
