'use client';

import { useState } from 'react';

import { startEnableBankingConnection } from './connect-bank.js';

export function ConnectBankButton() {
  const [status, setStatus] = useState<'idle' | 'starting' | 'failed'>('idle');

  async function connect(): Promise<void> {
    setStatus('starting');
    try {
      await startEnableBankingConnection(document.cookie, fetch, (url) =>
        window.location.assign(url),
      );
    } catch {
      setStatus('failed');
    }
  }

  return (
    <section>
      <h2>Open Banking sandbox</h2>
      <button type="button" disabled={status === 'starting'} onClick={() => void connect()}>
        {status === 'starting' ? 'Connecting…' : 'Connect Bank'}
      </button>
      <p aria-live="polite">{status === 'failed' ? 'Connection could not be started.' : null}</p>
    </section>
  );
}
