'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, LoaderCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { decodePasscode } from '@/lib/passcode';
import { Backdrop } from '@/components/Backdrop';
import { RoomPreview } from '@/components/RoomPreview';
import { Shell, TopBar } from '@/components/Shell';
import { joinRoom } from '@/lib/session';
import { EnterRefused, Signaling } from '@/lib/signaling';
import type { RoomSummary } from '@rave/protocol';

/**
 * The passcode a share link or QR carries, if it carries one.
 *
 * In the fragment rather than the query: a fragment never leaves the
 * browser, so the passcode does not land in the web server's logs. Encoded,
 * so it is not readable on sight (see lib/passcode.ts).
 */
function linkedPasscode(): string | undefined {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('p');
  return encoded === null ? undefined : decodePasscode(encoded);
}

/**
 * The tap that arms audio. A link that auto-entered the room would produce a
 * device that is joined and silent at playback with no recovery, so there is
 * no path into a room that skips this screen — a refresh lands here again.
 *
 * The room is shown as the room list shows it, found by its code in that
 * list, so a person can see what they are about to join without anything new
 * on the server. A code not in the list (a typo, a room that just ended)
 * shows nothing here and is reported after the tap.
 */
export function PreJoin({ code, locked }: { code: string; locked: boolean }) {
  const [displayName, setDisplayName] = useState('');
  const [passcode, setPasscode] = useState('');
  // Asked for up front when the room list said so; otherwise only once the
  // server says the room needs one, or that the one a link carried is wrong.
  const [askPasscode, setAskPasscode] = useState(locked);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const [rooms, setRooms] = useState<RoomSummary[] | undefined>(undefined);
  useEffect(() => {
    const signaling = new Signaling();
    const stop = signaling.watchRooms(setRooms);
    return () => {
      stop();
      signaling.close();
    };
  }, []);
  const room = rooms?.find((r) => r.code === code);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (displayName.trim() === '' || joining) return;
    setError(null);
    setJoining(true);
    try {
      // Must stay synchronous up to here: joinRoom opens the AudioContext,
      // and this submit is the user gesture that lets it start.
      await joinRoom({
        code,
        displayName: displayName.trim(),
        // What was typed wins over what the link carried: the field only
        // appears once the link's own passcode has failed or was absent.
        passcode: passcode || linkedPasscode(),
      });
    } catch (err) {
      if (err instanceof EnterRefused && err.code.startsWith('passcode-')) setAskPasscode(true);
      setError(err instanceof Error ? err.message : 'Could not join the room.');
      setJoining(false);
    }
  }

  return (
    <Shell backdrop={<Backdrop title={room?.roomName ?? 'party'} still calm />}>
      <TopBar>
        <Link href="/" aria-label="Back to rooms" className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/12 hover:text-foreground">
          <ArrowLeft className="size-5" />
        </Link>
        Join a room
      </TopBar>
      <div className="grid flex-1 place-items-start justify-items-center p-4 sm:p-8">
      <div className="flex w-full max-w-110 animate-rise flex-col gap-6 rounded-[28px] glass p-6 text-card-foreground">
        <h1 className="text-3xl font-bold tracking-tight">Join the room</h1>
        {room && (
          <div>
            <RoomPreview
              name={room.roomName}
              description={room.description}
              mode={room.mode}
              memberCount={room.memberCount}
              hasPasscode={room.hasPasscode}
              nowPlaying={room.nowPlaying}
            />
          </div>
        )}

        <form onSubmit={join} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="display-name" className="text-sm font-semibold text-muted-foreground">
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

          {askPasscode && (
            <div className="flex animate-pop flex-col gap-2">
              <label htmlFor="passcode" className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <Lock className="size-4" />
                Room passcode
              </label>
              <Input
                id="passcode"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                maxLength={32}
                autoComplete="off"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={displayName.trim() === '' || joining}>
            {joining ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
            {joining ? 'Joining…' : 'Join room'}
          </Button>
        </form>
      </div>
      </div>
    </Shell>
  );
}
