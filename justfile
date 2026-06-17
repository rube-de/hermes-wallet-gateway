# hermes-wallet-gateway — build/push the gateway image and run the local stack.
# Chain id + WalletConnect project are RUNTIME config (set on the running
# container via WALLET_CHAIN_ID / WALLET_WC_PROJECT_ID), so the image is generic
# — no build args needed. Override the image with GATEWAY_IMAGE=…

image := env_var_or_default("GATEWAY_IMAGE", "ghcr.io/rube-de/hermes-wallet-gateway:latest")

# list recipes
default:
    @just --list

# Build the linux/amd64 image (clean single-arch manifest, required for ROFL).
build:
    docker buildx build --platform linux/amd64 --provenance=false \
      -f gateway/Dockerfile -t {{image}} .

# Build and push (make the GHCR package PUBLIC afterwards so ROFL can pull it).
push:
    docker buildx build --platform linux/amd64 --provenance=false \
      -f gateway/Dockerfile -t {{image}} --push .

# Inspect the pushed image's manifest / platform.
inspect:
    docker buildx imagetools inspect {{image}}

# Local smoke stack (gateway + mock upstream) on http://127.0.0.1:8080.
# Pass a WalletConnect id for mobile/QR:  just dev wc=<id>
dev wc="":
    WALLET_WC_PROJECT_ID={{wc}} docker compose -f compose.local.yml up --build

# Tear down the local stack.
down:
    docker compose -f compose.local.yml down

# Headless checks (no browser, no Docker): SIWE flow + path routing + config validation.
smoke:
    cd gateway && npm ci && npm test

# Typecheck the login app (the gateway runs .ts directly, validated by `smoke`).
check:
    cd login-app && npm ci && npm run typecheck
