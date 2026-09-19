'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useParams } from 'next/navigation';
import { getSession, patchSession, subscribeSession } from '@/lib/session';
import { Roster } from '@/components/Roster';
import { PreJoin } from './PreJoin';

export function RoomClient() {
  const params = useParams<{ code: string }>();
  const session = useSyncExternalStore(subscribeSession, getSession, () => undefined);

  // Keyed on the socket, not the session: patchSession replaces the session
  // object on every update, and re-subscribing each time would stack handlers.
  const signaling = session?.signaling;
  useEffect(() => {
    if (!signaling) return;
    const unsubscribeMessage = signaling.onMessage((msg) => {
      if (msg.type === 'room-state') patchSession({ state: msg });
      if (msg.type === 'room-closed') patchSession({ closed: true });
    });
    // A dropped socket leaves the roster frozen and looking live. Reuse the
    // closed banner: from here the room is over either way.
    const unsubscribeClose = signaling.onClose(() => patchSession({ closed: true }));
    return () => {
      unsubscribeMessage();
      unsubscribeClose();
    };
  }, [signaling]);

  // No session means a refresh or a pasted link — the tap that arms audio has
  // not happened, so this is where it happens.
  const code = params?.code?.toUpperCase();
  if (!session) return code ? <PreJoin code={code} /> : null;

  const { state } = session;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">{state.roomName}</p>
        <h1 className="font-mono text-4xl font-semibold tracking-[0.2em]">{state.code}</h1>
        {session.fileName && session.buffer && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {session.fileName} · {formatDuration(session.buffer.duration)}
          </p>
        )}
      </header>

      {session.closed && (
        <p
          role="alert"
          className="rounded-md border border-[var(--color-destructive)] p-3 text-sm text-[var(--color-destructive)]"
        >
          This room has ended. The person who created it left.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-[var(--color-muted-foreground)]">
          In the room
        </h2>
        <Roster peers={state.peers} selfPeerId={session.peerId} />
      </section>
    </main>
  );
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
