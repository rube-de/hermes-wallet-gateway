import { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage } from 'wagmi';
import { createSiweMessage } from 'viem/siwe';
import { CHAIN_ID } from './runtime';

// CHAIN_ID is the SIWE chain assertion (must match the gateway's WALLET_CHAIN_ID).
// It's only an assertion in the signed message — the user does NOT have to be on
// this network (personal_sign is chain-agnostic and costs nothing).
const STATEMENT = 'Sign in to the Hermes dashboard.';

export default function App() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn() {
    if (!address) return;
    setError('');
    setBusy(true);
    try {
      // 1. server-issued single-use nonce
      const { nonce } = (await fetch('/siwe/nonce').then((r) => r.json())) as { nonce: string };
      // 2. build the EIP-4361 message (domain pinned to where we're served)
      const message = createSiweMessage({
        address,
        chainId: CHAIN_ID,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: '1',
        statement: STATEMENT,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 5 * 60 * 1000),
      });
      // 3. sign (works for injected + WalletConnect/mobile via the connected wallet)
      const signature = await signMessageAsync({ message });
      // 4. verify + mint session
      const res = await fetch('/siwe/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        window.location.assign('/'); // session cookie set -> gateway proxies to Hermes
        return;
      }
      // The server returns a deliberately generic 401 for ANY verify failure
      // (allowlist miss, expired/replayed nonce, domain/chain mismatch) so it
      // can't be used as an allowlist oracle — so we can't honestly single out
      // "not on the allowlist" here.
      if (res.status === 401) {
        setError('Sign-in failed — your wallet may not be on the allowlist, or the request expired. Please try again.');
      } else if (res.status === 429) setError('Too many attempts. Please wait a moment.');
      else setError('Sign-in failed. Please try again.');
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err?.shortMessage || err?.message || 'Signature rejected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card">
      <div className="brand">Hermes</div>
      <h1>Sign in</h1>
      <p className="sub">{STATEMENT}</p>

      <div className="row">
        <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
      </div>

      {isConnected && (
        <button className="signin" type="button" onClick={signIn} disabled={busy}>
          {busy ? 'Check your wallet…' : 'Sign in with this wallet'}
        </button>
      )}

      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </main>
  );
}
