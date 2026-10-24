'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, LoaderCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { decodePasscode } from '@/lib/passcode';
import { Backdrop } from '@/components/Backdrop';
import { Tag } from '@/components/Tag';
import { RoomPreview } from '@/components/RoomPreview';
import { Header, Shell } from '@/components/Shell';
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
function rememberedName(): string {
  try {
    return localStorage.getItem('rave:name') ?? '';
  } catch {
    return '';
  }
}

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
  // After mount, so the server's empty field and the first client render agree.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDisplayName((name) => name || rememberedName()), []);
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
      try {
        localStorage.setItem('rave:name', displayName.trim());
      } catch {}
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
    <Shell
      backdrop={<Backdrop title={room?.roomName ?? 'party'} calm />}
      header={<Header back="/" title="Join a room" />}
      cta={
        <Button
          type="submit"
          form="join-form"
          size="lg"
          disabled={displayName.trim() === '' || joining}
          className="w-full"
        >
          {joining ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
          {joining ? 'Joining…' : 'Join room'}
        </Button>
      }
      aside={
        <>
          <section className="plunk block-lime mr-[3px] mb-[3px] flex animate-rise flex-col gap-2 p-5">
            <h1 className="font-display text-[2rem] leading-[0.95] tracking-tight lg:text-[2.75rem]">
              {room ? room.roomName : 'Join the room'}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone="host" className="font-mono">
                {code}
              </Tag>
              {room && (
                <Tag tone={room.mode === 'talk' ? 'talk' : 'music'}>{room.mode === 'talk' ? 'Talk' : 'Music'}</Tag>
              )}
              {(room?.hasPasscode ?? locked) && <Tag tone="locked">Locked</Tag>}
              {room && (
                <span className="font-display text-xl">
                  {room.memberCount} {room.memberCount === 1 ? 'person' : 'people'} inside
                </span>
              )}
            </div>
          </section>
          {room && (
            <RoomPreview
              name={room.roomName}
              description={room.description}
              mode={room.mode}
              memberCount={room.memberCount}
              hasPasscode={room.hasPasscode}
              nowPlaying={room.nowPlaying}
            />
          )}
        </>
      }
    >
      <form id="join-form" onSubmit={join} className="flex flex-col gap-3">
        <div className="flat flex items-start gap-4 p-4 focus-within:border-ring">
          <span
            aria-hidden
            className="font-display text-4xl leading-none text-transparent [-webkit-text-stroke:1px_var(--color-ring)]"
          >
            01
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label htmlFor="display-name" className="text-[0.8125rem] font-extrabold tracking-wide text-ring uppercase">
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
        </div>

        {askPasscode && (
          <div className="flat flex animate-pop items-start gap-4 p-4 focus-within:border-ring">
            <span
              aria-hidden
              className="font-display text-4xl leading-none text-transparent [-webkit-text-stroke:1px_var(--color-ring)]"
            >
              02
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label
                htmlFor="passcode"
                className="flex items-center gap-1.5 text-[0.8125rem] font-extrabold tracking-wide text-ring uppercase"
              >
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
          </div>
        )}

        <p className="text-sm text-muted-foreground">Audio starts on this device when you join.</p>

        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}{' '}
            <Link href="/" className="underline">
              Back to rooms
            </Link>
          </p>
        )}
      </form>
    </Shell>
  );
}
