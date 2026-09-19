'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getSession, patchSession, subscribeSession } from '@/lib/session';
import { Roster } from '@/components/Roster';

export function RoomClient() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const session = useSyncExternalStore(subscribeSession, getSession, () => undefined);

  useEffect(() => {
    // No session means a refresh or a pasted link. There is no armed audio
    // and no socket here, so the only honest move is back to the entry screen;
    // the pre-join tap that makes a link work arrives in #3.
    if (!session) router.replace('/');
  }, [session, router]);

  // Keyed on the socket, not the session: patchSession replaces the session
  // object on every update, and re-subscribing each time would stack handlers.
  const signaling = session?.signaling;
  useEffect(() => {
    if (!signaling) return;
    return signaling.onMessage((msg) => {
      if (msg.type === 'room-state') patchSession({ state: msg });
    });
  }, [signaling]);

  if (!session) return null;

  const { state } = session;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">{state.roomName}</p>
        <h1 className="font-mono text-4xl font-semibold tracking-[0.2em]">
          {params?.code ?? state.code}
        </h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {session.fileName} · {formatDuration(session.buffer.duration)}
        </p>
      </header>

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
