# Wallet-Gated Public Access for the Hermes Dashboard on Oasis ROFL

**Goal:** make the Hermes agent dashboard / mission control publicly accessible, but gated by a
whitelist of Ethereum addresses — user signs in with their wallet (Sign-In With Ethereum / EIP-4361),
the backend verifies the signature, checks the allowlist, and whitelisted users get in. A
wallet-based user-management layer in front of the Hermes dashboard (and other public Hermes-built
sites), deployed via Docker on Oasis ROFL.

**Verdict:** Feasible and clean. Two viable architectures; for the stated priority (avoid
re-forking/rebuilding Hermes on every version) the **gateway** architecture wins. All Hermes claims
below are grounded in a direct read of the `dashboard_auth` source (`file:line` cited); all ROFL
claims are grounded in official Oasis docs (URLs cited).

---

## 1. The two architectures

| | **A — In-tree provider** | **B — Gateway (recommended)** |
|---|---|---|
| Shape | New `plugins/dashboard_auth/wallet/` provider + a 3-file core patch | Stock Hermes `--insecure` on an internal network + a small wallet-auth gateway in front |
| Hermes image | **Fork.** The plugin backend is volume-mountable, but the login-page/route patch is core → rebuild & re-reconcile every version | **Untouched.** Reference the published image by digest; version bump = change the tag |
| Login UX | Native "Connect Wallet" button on Hermes's own `/login` | Your own login page; full control |
| Ongoing cost | Carry a core patch forever (or upstream it to Nous) | Run one extra small service; must proxy WebSockets |
| Whitelist/SIWE logic | In the plugin | In the gateway |

Both reuse the same SIWE + whitelist + session logic (Sections 4–6); only *where it runs* differs.

### Why A requires a fork (the precise gap)

Hermes already ships a pluggable dashboard-auth system, so the *session* half of wallet auth is a
clean drop-in — but the *login handshake* half is not:

- **Provider contract** (`dashboard_auth/base.py:75-184`): `DashboardAuthProvider` ABC with
  `start_login`/`complete_login`/`verify_session`/`refresh_session`/`revoke_session`, plus an optional
  non-redirect `complete_password_login` (gated by `supports_password`). Returns a frozen 8-field
  `Session` (`base.py:9-26`).
- **Gate dispatch** (`dashboard_auth/middleware.py:226-244`): on every request the gate **trials each
  registered provider's `verify_session` until one returns non-`None`**. The session cookie carries
  **only** the opaque token — no provider name (`cookies.py:128-167`). So a stateless wallet token
  signed with the plugin's own HMAC secret is matched automatically — **no middleware change for
  verification.** (Caveat: the provider must add an `iss:"wallet"` claim and fast-reject foreign
  tokens by returning `None`, or it could mis-claim another provider's session.)
- **Stateless session template** (`plugins/dashboard_auth/basic/__init__.py:176-193, 293-312`):
  HMAC-SHA256 `_sign`/`_unsign`, `register(ctx)` → `ctx.register_dashboard_auth_provider(...)`. A wallet
  provider copies this verbatim.
- **The gap — login UI + nonce challenge:** the login page (`dashboard_auth/login_page.py:458-498`) is
  a fixed server-rendered template with exactly two render modes per provider (OAuth `<a>` button or
  username/password `<form>`) and **no hook to inject `window.ethereum` / wallet-connect JS**. And the
  route table (`routes.py:130-621`) is a fixed `APIRouter` with **no nonce endpoint and no
  per-plugin route registration**. So a first-class wallet login needs ~3 core edits: add
  `GET /auth/siwe-nonce` + `POST /auth/siwe-verify` to `routes.py`, allowlist them in
  `middleware._GATE_PUBLIC_PREFIXES` (exact strings — never a bare `/auth/`), and add a `supports_siwe`
  branch + signing script to `login_page.py`. None are rewrites, but all are **core** → fork.

**Plugin discovery (relevant to A):** plugins load from `<repo>/plugins/`, **`~/.hermes/plugins/`**, and
`./.hermes/plugins/` (`hermes_cli/plugins.py:7-12`); in Docker `~/.hermes` is the mounted volume
(`HERMES_HOME=/opt/data`). So the *provider backend* could ship as a volume-mounted plugin with no
rebuild — but the login-page/route patch can't, which is what forces the fork for A.

---

## 2. Recommended architecture (B): gateway in front of stock Hermes

```
                         ROFL app (TDX TEE, Podman compose)
  Internet               ┌───────────────────────────────────────────────────────┐
     │  HTTPS            │   ports: ["8080:8080"]        internal Podman network   │
     └──► ROFL proxy ───►│   ┌─────────────────────┐    (service-name DNS;         │
        (TLS in-enclave) │   │  wallet-gateway     │     no published port)        │
                         │   │  • GET  /siwe/nonce │    ┌────────────────────────┐ │
                         │   │  • POST /siwe/verify│──► │ hermes-dashboard       │ │
                         │   │    recover+whitelist│    │ STOCK image @sha256    │ │
                         │   │  • signed cookie    │    │ dashboard --host       │ │
                         │   │  • reverse-proxy +  │    │  0.0.0.0 --insecure    │ │
                         │   │    WS passthrough   │    │  --port 9119           │ │
                         │   └─────────┬───────────┘    └───────────┬────────────┘ │
                         │             ▼ off-chain whitelist         │ hermes-gateway│
                         │       (env / ROFL secret)                 │ STOCK         │
                         └───────────────────────────────────────────────────────┘
```

**Request flow:** ROFL proxy terminates TLS and forwards plaintext to the gateway's published port.
The gateway checks for a valid signed session cookie. If absent → serve the wallet-login page. The
page connects the wallet, fetches a nonce, builds + signs an EIP-4361 message, and POSTs it back; the
gateway recovers the address, checks the off-chain whitelist, and sets an HttpOnly session cookie. With
a valid cookie, the gateway transparently reverse-proxies all traffic — including WebSocket upgrades —
to the internal Hermes dashboard.

**Why Hermes runs `--insecure`:** the dashboard's own auth gate only engages on a non-loopback bind,
and `--insecure` disables it. That is safe here *only because* the dashboard publishes **no host/proxy
port** — the gateway is the sole reachable entrypoint and enforces wallet auth. (The stock
`docker-compose.yml:13-17` warns against `--insecure --host 0.0.0.0` *on a LAN*; behind a private
Podman network with no published port, the gateway-is-the-perimeter pattern is exactly the
reverse-proxy model Nous recommends.) For belt-and-suspenders you can instead leave Hermes' basic-auth
on and have the gateway drive its cookie login, but that adds real complexity (Hermes basic-auth is a
form POST that sets a cookie, not an HTTP Basic header) — not recommended for v1.

---

## 3. ROFL deployment (verified against official docs)

| Concern | Finding | Source |
|---|---|---|
| Container model | `kind: container` TDX apps run **multiple OCI containers via Podman**, defined by a `compose.yaml`/`docker-compose.yaml` referenced from `rofl.yaml`. Confirmed by the official `demo-trustless-agent` (3 containers). | [containerize-app](https://docs.oasis.io/build/rofl/workflow/containerize-app/) |
| Stock upstream images | Yes — reference any public image verbatim. **Must be fully-qualified** (`ghcr.io/...`, `docker.io/...`). Digest pinning (`@sha256:…`) advised for reproducibility, not enforced. | [containerize-app](https://docs.oasis.io/build/rofl/workflow/containerize-app/) |
| **Public exposure** | **Built-in port proxy** → public HTTPS URL with **TLS terminated inside the TEE**, auto Let's Encrypt, custom domains. Modes: `terminate-tls` (default) / `passthrough` / `ignore` via `net.oasis.proxy.ports.<port>.<setting>` annotations. **No Caddy/Traefik needed for TLS/ingress.** | [features/proxy](https://docs.oasis.io/build/rofl/features/proxy/) |
| Secrets/config | `echo -n val \| oasis rofl secret set NAME -` then `oasis rofl update`. **E2E-encrypted with an ephemeral network key; only decryptable inside an attested enclave** (even the admin can't read them back). Exposed as **env vars** (or `/run/secrets/<name>`). | [features/secrets](https://docs.oasis.io/build/rofl/features/secrets) |
| Internal networking | Podman default compose network; services reach each other by **service-name DNS**. Only ports under `ports:` reach the proxy. (Demo: Postgres unpublished, only the app publishes.) | [demo-trustless-agent](https://github.com/oasisprotocol/demo-trustless-agent) |
| TEE / attestation / keys | Intel **TDX**; on-chain `app_id`; auto remote attestation. **secp256k1 key derivation** via `@oasisprotocol/rofl-client` (`generateKey(keyId, SECP256K1)`) → stable hex privkey usable with ethers/viem; key never leaves the enclave. Sapphire contracts verify a ROFL origin via `roflEnsureAuthorizedOrigin()` (`Subcall.sol`). | [key-generation](https://docs.oasis.io/build/use-cases/key-generation/) |
| Resources | Demo uses `memory: 2048, cpus: 1, storage 10 GiB`. Playground offer: 4096 MiB / 2 vCPU / 20 GiB. Hermes is heavy (Playwright/Chromium + Node + Python baked in) → request **~4096 MiB**. Mainnet costs ROSE (use `oasis rofl deploy --show-offers`). | [deploy](https://docs.oasis.io/build/rofl/workflow/deploy/) |

**Caddy/Traefik verdict:** the ROFL proxy replaces them for **TLS + ingress**. The app-layer
auth+reverse-proxy logic still needs a gateway service — but that's one small service you own, not
Caddy. (If you ever prefer config over code for the proxy layer, ROFL proxy → Caddy `forward_auth` →
tiny auth service is an equivalent alternative; not needed for v1.)

---

## 4. SIWE handshake (EIP-4361)

1. Client `GET /siwe/nonce` → server returns a high-entropy, **single-use, server-stored** nonce with
   a short TTL.
2. Client builds the EIP-4361 message: `domain` = the public host (pinned server-side, **not** from a
   client `Host` header), `uri`, `address`, `chainId`, the nonce, `issuedAt`, optional `expirationTime`.
3. Wallet signs via `personal_sign` (EIP-191).
4. Client `POST /siwe/verify {message, signature}`.
5. Server: recover signer → assert `recovered == message.address` → **domain matches** → **nonce was
   issued, unused, unexpired** (consume it now) → `chainId` allowed → **whitelist check on the
   normalized (lowercased) address** → mint a signed session cookie. Replay protection rests on the
   **server-side single-use nonce**, never on the raw signature bytes (ECDSA malleability).

**Library note:** use **viem** on the gateway (`generateSiweNonce`, `verifySiweMessage`) — it covers
EOA verification cleanly and EIP-1271 (smart-contract wallets) later via a public client. This avoids
the Python `siwe` library version ambiguity (the lib is on the **2.x** line; an earlier draft's
`siwe==4.4.0` pin was wrong, and it has **no `VerificationError` base class** — exceptions are
concrete: `ExpiredMessage`/`DomainMismatch`/`NonceMismatch`/`InvalidSignature`/…). **Ship EOA-only for
v1**; `ecrecover` fails for Safe/AA wallets — add EIP-1271 as a fast-follow.

---

## 5. Whitelist — off-chain list first (chosen), with an upgrade path

`is_allowed(address) -> bool` is one predicate, called once after address recovery on the lowercased
address, before minting the session. Keep it behind that interface so upgrades are a backend swap, not
an auth rewrite. **One source of truth — don't mirror the list into two places.**

**v1 (now): off-chain list.** Comma-separated addresses injected as a **ROFL secret**
(`HERMES_DASHBOARD_WALLET_WHITELIST`) — E2E-encrypted, never in the image, only decrypted in the
attested TEE. Zero gas, zero RPC, best privacy, edit-and-`oasis rofl update` to change. Normalize to
lowercase on both write and read (a checksum-vs-lowercase mismatch silently denies legit users). If you
outgrow env, move to a small DB table `allowlist(address PK, label, added_at, revoked_at)` for instant
per-user removal — same interface.

**Upgrade path (later):**

| Option | `is_allowed()` | Privacy | Note |
|---|---|---|---|
| Off-chain list/DB (**v1**) | in-memory set / `SELECT` | Best | zero gas/RPC; instant revoke |
| Token-gating (ERC-721/1155/20) | `balanceOf(addr) > 0` | Balances public | self-service membership; you don't control transfers |
| **Sapphire confidential mapping** | authenticated `eth_call isAllowed(addr, token)` | **On-chain + private** | see below |
| Merkle root / EAS attestation | proof walk / attestation resolve | Strong | large rosters / portable per-user revoke |

**Why Sapphire is the compelling on-chain option:** a `mapping(address=>bool)` on a *public* chain
**publishes your entire member roster forever**. Sapphire is a confidential EVM — state is encrypted,
so the set isn't enumerable. **Two protections, both required:** (a) bulk secrecy is automatic from
encrypted state; (b) **probe secrecy requires gating the read path** — a bare `isAllowed(address)` view
is callable by anyone (`msg.sender == address(0)` for unauthenticated `eth_call`), so make it
`isAllowed(address, token)` reader-only via `SiweAuth`/EIP-712, or attackers enumerate by guessing.
Never `emit`/revert with an address (logs aren't encrypted). The **gateway runs in a ROFL TEE and can
hold a secp256k1 key** (Section 3) to authenticate the confidential read — a genuinely Oasis-native
fit. Worth it only when the roster must be on-chain/auditable **and** secret; otherwise the off-chain
list is simpler and free. *(To verify at build time: whether `roflEnsureAuthorizedOrigin` checks the
appd tx-signing key vs. a derived key.)*

**Revocation latency is bounded by the session-TTL, not the whitelist backend** — removing an address
doesn't kill an already-issued cookie until it expires (or until you re-check `is_allowed` on each
request / on refresh). Pick a short session TTL for tight revocation.

---

## 6. Security checklist

- **Domain binding:** pin the expected SIWE `domain` server-side from the public host; don't trust a
  client `Host` header. Missing/wrong domain loses phishing protection.
- **Nonce store:** single-use, short TTL, **consume on first successful verify**. Must be **shared
  across gateway workers/replicas** (in-memory dict breaks non-deterministically behind >1 worker — the
  #1 real-world break). One gateway replica is fine for v1; use Redis if you scale out.
- **Replay:** key on the nonce, never the raw signature (ECDSA malleability); enforce low-s.
- **Session cookie:** `HttpOnly`, `SameSite=Lax`, `Secure` (set behind the TLS-terminating proxy),
  HMAC/JWT-signed with a **stable** secret (a random per-process secret kills sessions on restart and
  across replicas). Short access TTL; optional refresh.
- **Rate-limit** `/siwe/verify` (per-IP sliding window) and return a **generic 401** (no
  address-vs-signature distinction → no enumeration oracle).
- **EOA-only v1:** clear error for contract wallets; EIP-1271 as a fast-follow.
- **Public exposure:** the ROFL proxy gives HTTPS + `X-Forwarded-Proto`; make sure the gateway treats
  the connection as HTTPS for the `Secure` cookie. Hermes stays `--insecure` on the internal network
  with **no published port**.
- **Sapphire (if/when used):** gate the read path; never emit/revert addresses; authenticate the
  backend query.

---

## 7. Phasing & effort

- **Phase 1 — gateway + off-chain list + EOA SIWE (MVP):** ~3–5 days. Node gateway (viem SIWE +
  `http-proxy` for HTTP/WS passthrough + signed cookie), off-chain whitelist via ROFL secret, ROFL
  `compose.yaml` + `rofl.yaml`, stock Hermes by digest. Deploy to ROFL testnet.
- **Phase 2 — Sapphire confidential whitelist:** ~3–5 days. Swap `is_allowed()` to an authenticated
  read of a Sapphire mapping using a TEE-derived secp256k1 key; short-TTL cache, fail-closed on RPC error.
- **Phase 3 — EIP-1271, token-gating, admin UI:** incremental.

---

## 8. Open items to confirm at build time

1. Hermes dashboard internal port/flags in a container (`--host 0.0.0.0 --insecure --port 9119`;
   confirm `--insecure` semantics and default port `9119`).
2. WebSocket endpoint set to pass through (`/api/pty`, `/api/ws`, `/api/pub`, `/api/events`,
   `/api/auth/ws-ticket`).
3. `siwe`/viem versions pinned and verified at install (use viem to sidestep the Python lib ambiguity).
4. Nonce store shared if the gateway is ever scaled beyond one replica.
5. Sapphire (Phase 2 only): whether `roflEnsureAuthorizedOrigin` matches the appd signing key vs. a
   derived key; Testnet chainId 23295 before Mainnet 23294.
6. ROFL mainnet pricing via `oasis rofl deploy --show-offers`.

---

*Sources: Hermes `dashboard_auth` source (read at `file:line` as cited); Oasis docs as linked. Design
validated by a multi-agent research pass + an adversarial review (verdict: sound-with-caveats; all
caveats were in illustrative code, since corrected here).*
