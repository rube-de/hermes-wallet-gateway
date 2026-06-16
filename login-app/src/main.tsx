import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, getDefaultConfig, darkTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

import App from './App';
import './index.css';

// WalletConnect needs a (free) project id from https://cloud.reown.com.
// Injected wallets (MetaMask, Rabby, Coinbase ext...) work without it; mobile /
// WalletConnect QR requires a real id. Injected at build time as VITE_WC_PROJECT_ID.
const config = getDefaultConfig({
  appName: 'Hermes Dashboard',
  projectId: import.meta.env.VITE_WC_PROJECT_ID || 'GET_ONE_AT_cloud.reown.com',
  chains: [mainnet],
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
