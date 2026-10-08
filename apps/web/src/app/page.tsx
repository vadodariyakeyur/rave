'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Lock, Music, Music2, Plus, Speaker, Users } from 'lucide-react';
import type { RoomSummary } from '@rave/protocol';
import { buttonVariants } from '@/components/ui/button';
import { Equalizer } from '@/components/Equalizer';
import { Signaling } from '@/lib/signaling';
import { cn } from '@/lib/utils';

/**
 * Every live room, kept current for as long as the page is open.
 *
 * Its own socket rather than a shared one: the room's socket is created on
 * the tap that arms audio and belongs to that room, and this page has
 * neither a tap nor a room yet.
 */
export default function Home() {
  // Undefined until the first list arrives, which is not the same as empty.
  const [rooms, setRooms] = useState<RoomSummary[] | undefined>(undefined);
  useEffect(() => {
    const signaling = new Signaling();
    const stop = signaling.watchRooms(setRooms);
    return () => {
      stop();
      signaling.close();
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-12 px-5 py-6 sm:px-8 sm:py-8">
      <header className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <Equalizer className="h-5 text-primary" />
          rave
        </p>
        <Link href="/create" className={buttonVariants()}>
          <Plus />
          Create room
        </Link>
      </header>

      <section className="grid items-center gap-10 md:grid-cols-[1.2fr_1fr]">
        <div className="flex animate-rise flex-col gap-4">
          <h1 className="text-5xl font-extrabold sm:text-6xl">
            Every phone in the room, one big speaker.
          </h1>
          <p className="max-w-[46ch] text-lg text-muted-foreground">
            Start a room, drop in some tracks, and every device that joins plays the same beat at
            the same instant.
          </p>
        </div>
        <Phones />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">Open rooms</h2>
        {rooms === undefined ? (
          <div role="status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <span className="sr-only">Looking for rooms…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <div className="flex animate-pop flex-col items-start gap-3 rounded-xl border-2 border-dashed border-border p-6 sm:p-8">
            <Speaker className="size-8 text-primary" />
            <p className="max-w-[48ch] text-muted-foreground">
              No rooms are open right now. Create one and others on this network will see it here.
            </p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room, index) => (
              <li
                key={room.code}
                className="animate-pop"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {/* The whole card is the link: it is the only thing to do
                    with a room, and a small target on a phone is a miss. */}
                <Link
                  href={`/room/${room.code}${room.hasPasscode ? '?locked=1' : ''}`}
                  className="group flex h-full flex-col gap-4 rounded-xl border-2 border-border bg-card p-5 text-card-foreground shadow-md transition-[translate,rotate,box-shadow] duration-150 ease-out hover:-translate-y-1 hover:-rotate-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-1 active:rotate-0 active:shadow-none"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-2 text-xl font-bold">
                      <span className="truncate">{room.roomName}</span>
                      {room.hasPasscode && (
                        <Lock aria-label="Needs a passcode" className="size-4 shrink-0" />
                      )}
                    </span>
                    {room.description && (
                      <span className="line-clamp-2 text-sm text-muted-foreground">
                        {room.description}
                      </span>
                    )}
                  </span>
                  {room.nowPlaying && (
                    <span className="flex min-w-0 items-center gap-2 text-sm text-primary">
                      <Equalizer />
                      <span className="truncate">playing {room.nowPlaying}</span>
                    </span>
                  )}
                  <span className="mt-auto flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Users className="size-4" />
                      {room.memberCount} {room.memberCount === 1 ? 'person' : 'people'}
                    </span>
                    <span className="flex items-center gap-1 font-semibold">
                      Join
                      <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-1" />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

const PHONES = ['-rotate-6 translate-y-3', 'rotate-3 -translate-y-2', '', 'rotate-6 translate-y-4'];

/** The product, drawn: several phones, one beat. The primary one is the host. */
function Phones() {
  return (
    <div aria-hidden className="relative flex animate-rise items-center justify-center gap-3 py-8 [animation-delay:120ms]">
      <Music className="absolute bottom-6 left-[12%] size-5 animate-float text-muted-foreground" />
      <Music2 className="absolute bottom-10 left-[46%] size-4 animate-float text-muted-foreground [animation-delay:1.3s]" />
      <Music className="absolute right-[10%] bottom-4 size-5 animate-float text-muted-foreground [animation-delay:2.6s]" />
      {PHONES.map((tilt, index) => {
        const host = index === 2;
        return (
          <div key={index} className={cn('relative', tilt)}>
            {host && (
              <>
                <span className="absolute inset-0 m-auto size-20 animate-ring rounded-full border-2 border-primary" />
                <span className="absolute inset-0 m-auto size-20 animate-ring rounded-full border-2 border-primary [animation-delay:1.2s]" />
              </>
            )}
            <div
              className={cn(
                'relative grid h-36 w-18 place-items-center rounded-[calc(var(--radius)*0.75)] border-2 border-border shadow-lg sm:h-44 sm:w-22',
                host ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground',
              )}
            >
              <Equalizer className="h-8 gap-1" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
