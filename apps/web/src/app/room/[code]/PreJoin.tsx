'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { joinRoom } from '@/lib/session';

/**
 * The tap that arms audio. A link that auto-entered the room would produce a
 * device that is joined and silent at playback with no recovery, so there is
 * no path into a room that skips this screen — a refresh lands here again.
 *
 * Only the code is shown: the room name lives on the server, and asking for
 * it before joining would mean a lookup round-trip for every typo. An unknown
 * code is reported here, after the tap.
 */
export function PreJoin({ code }: { code: string }) {
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (displayName.trim() === '' || joining) return;
    setError(null);
    setJoining(true);
    try {
      // Must stay synchronous up to here: joinRoom opens the AudioContext,
      // and this submit is the user gesture that lets it start.
      await joinRoom({ code, displayName: displayName.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the room.');
      setJoining(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-8">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">Joining room</p>
        <h1 className="font-mono text-4xl font-semibold tracking-[0.2em]">{code}</h1>
      </header>

      <form onSubmit={join} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="display-name" className="text-sm font-medium">
            Your name
          </label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Sam"
            autoComplete="off"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            {error}
          </p>
        )}

        <Button type="submit" disabled={displayName.trim() === '' || joining}>
          {joining ? 'Joining…' : 'Join room'}
        </Button>
      </form>
    </main>
  );
}
