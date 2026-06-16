# Multi-stage build. Build context is the REPO ROOT (so both gateway/ and
# login-app/ are available). Compose sets context: . and dockerfile: gateway/Dockerfile.

# --- stage 1: build the RainbowKit/wagmi React login app ---
# Pinned to $BUILDPLATFORM (the native builder arch) so the heavy Vite build runs
# WITHOUT QEMU emulation when cross-building for amd64 — the output (dist/) is
# static JS/HTML, architecture-independent, so it's safe to build on any arch.
# Emulating this 4800-module build OOMs/kills buildkit; native keeps it fast.
FROM --platform=$BUILDPLATFORM node:24-alpine AS login-build
WORKDIR /login
# Toolchain for optional native addons (bufferutil/utf-8-validate via ws/
# WalletConnect). This stage is discarded — it does not affect the runtime image.
RUN apk add --no-cache python3 make g++
COPY login-app/package.json login-app/package-lock.json ./
RUN npm ci
COPY login-app/ ./
# WalletConnect project id + SIWE chain id are baked at build time.
ARG VITE_WC_PROJECT_ID=
ARG VITE_CHAIN_ID=1
ENV VITE_WC_PROJECT_ID=$VITE_WC_PROJECT_ID
ENV VITE_CHAIN_ID=$VITE_CHAIN_ID
RUN npm run build

# --- stage 2: gateway runtime ---
# node:24 runs TypeScript directly via built-in type stripping — no build step,
# what you read is what runs.
FROM node:24-alpine
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY gateway/src ./src
COPY --from=login-build /login/dist ./login-dist

ENV NODE_ENV=production
ENV LOGIN_DIST=/app/login-dist
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
