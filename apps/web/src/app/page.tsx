'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { parseServerMessage } from '@rave/protocol';

type Status = 'connecting' | 'connected' | 'failed';

/**
 * Scaffold placeholder. Proves the stack end to end: Tailwind + a vendored
 * shadcn component render, and the browser reaches `realtime` through Caddy
 * on a same-origin wss:// URL.
 *
 * Replaced by the create/join screen in #2.
 */
export default function Home() {
  const [status, setStatus] = useState<Status>('connecting');
  const [serverTime, setServerTime] = useState<string | null>(null);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/ws`);

    socket.onmessage = (event) => {
      const msg = parseServerMessage(String(event.data));
      if (msg?.type === 'server-hello') {
        setStatus('connected');
        setServerTime(msg.serverTime);
      }
    };
    socket.onerror = () => setStatus('failed');
    socket.onclose = () => setStatus((s) => (s === 'connected' ? 'failed' : s));

    return () => socket.close();
  }, []);

  // WebRTC needs a secure context. If this is false on a phone, the CA is
  // untrusted on that device and nothing from #4 onward will work there.
  const secure = typeof window !== 'undefined' && window.isSecureContext;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">rave</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Synchronized peer-to-peer audio rooms
        </p>
      </div>

      <dl className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm">
        <Row label="realtime">
          <span
            className={
              status === 'connected'
                ? 'text-green-400'
                : status === 'failed'
                  ? 'text-[var(--color-destructive)]'
                  : 'text-[var(--color-muted-foreground)]'
            }
          >
            {status}
          </span>
        </Row>
        <Row label="secure context">
          <span className={secure ? 'text-green-400' : 'text-[var(--color-destructive)]'}>
            {secure ? 'yes' : 'no — WebRTC will not work'}
          </span>
        </Row>
        {serverTime && (
          <Row label="server time (UTC)">
            <span className="font-mono text-xs">{serverTime}</span>
          </Row>
        )}
      </dl>

      <Button disabled className="w-full">
        Create a room — #2
      </Button>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[var(--color-muted-foreground)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
