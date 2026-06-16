import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { mainnet, sepolia, base, optimism, arbitrum, polygon } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, getDefaultConfig, darkTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

import App from './App';
import { WC_PROJECT_ID, CHAIN_ID } from './runtime';
import './index.css';

// chain id + WalletConnect project come from the gateway at runtime (see
// ./runtime). WalletConnect needs a free id from https://cloud.reown.com for
// mobile/QR; injected wallets (MetaMask, Rabby, ...) work without it.
const KNOWN = [mainnet, sepolia, base, optimism, arbitrum, polygon];
const activeChain = KNOWN.find((c) => c.id === CHAIN_ID) ?? mainnet;
const config = getDefaultConfig({
  appName: 'Hermes Dashboard',
  projectId: WC_PROJECT_ID || 'GET_ONE_AT_cloud.reown.com',
  chains: [activeChain],
  ssr: false,
});

const queryClient = new QueryClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

ReactDOM.createRoot(rootEl).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({ accentColor: '#ffac02', accentColorForeground: '#170d02' })}
        >
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
