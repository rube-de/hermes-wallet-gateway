// Runtime config the gateway injects as window.__HERMES_GATE__ when it serves
// index.html (see gateway/src/static.ts). This is what lets ONE built image
// serve any deployment: chain id and WalletConnect project come from the
// gateway's env, not from the Vite build.
//
// Fallback order: injected runtime value -> Vite build-time env (for `npm run
// dev`, where there's no gateway in front) -> sane default.

interface GateConfig {
  chainId?: number;
  wcProjectId?: string;
}

const injected: GateConfig =
  (typeof window !== 'undefined' &&
    (window as unknown as { __HERMES_GATE__?: GateConfig }).__HERMES_GATE__) ||
  {};

export const WC_PROJECT_ID: string =
  injected.wcProjectId || import.meta.env.VITE_WC_PROJECT_ID || '';

export const CHAIN_ID: number = Number(injected.chainId ?? import.meta.env.VITE_CHAIN_ID ?? 1);
