'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock, Mic } from 'lucide-react';
import type { RoomSummary } from '@rave/protocol';
import { Backdrop } from '@/components/Backdrop';
import { Cover } from '@/components/Cover';
import { Equalizer } from '@/components/Equalizer';
import { Shell, TopBar } from '@/components/Shell';
import { Signaling } from '@/lib/signaling';
import { cn } from '@/lib/utils';

/**
 * Every live room, kept current for as long as the page is open.
 *
 * Laid out the way Apple Music lays out Radio: a bold title, one banner in
 * the accent colour, then rows of big square covers with a line under each.
 * The page itself stays a flat graphite; the colour is in the covers.
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
    <Shell
      backdrop={<Backdrop title="party" still calm />}
      sidebar={
        rooms && rooms.length > 0 ? (
          <section aria-label="Live now" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
            <h2 className="px-3 pt-3 pb-1 text-sm font-semibold text-muted-foreground">Live now</h2>
            <ul className="flex flex-col gap-0.5">
              {rooms.map((room) => (
                <li key={room.code}>
                  <Link
                    href={`/room/${room.code}${room.hasPasscode ? '?locked=1' : ''}`}
                    className="flex items-center gap-3 rounded-[20px] p-2 transition-colors duration-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Cover title={room.roomName} className="size-11 rounded-lg" />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate font-semibold">{room.roomName}</span>
                      <span className="text-sm text-muted-foreground">{room.memberCount} here</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : undefined
      }
    >
      <TopBar>
        <Equalizer className="h-4 text-ring" />
        <h1>Rooms</h1>
      </TopBar>

      <section className="flex flex-col gap-8 px-2 pt-4 pb-6 sm:px-4">
        <div className="flex animate-rise flex-wrap items-center gap-x-8 gap-y-4 rounded-[20px] bg-primary px-6 py-5 text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.28)]">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/20">
            <Equalizer className="h-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold tracking-tight">Every phone in the room, one big speaker.</p>
            <p className="opacity-90">
              Add tracks, share the link, and everyone hears the same second at the same time.
            </p>
          </div>
          <Link
            href="/create"
            className="inline-flex h-11 items-center rounded-full bg-white px-6 font-semibold text-black transition-transform duration-200 ease-soft active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
          >
            Create room
          </Link>
        </div>

        <h2 className="text-4xl font-bold tracking-tight">Open rooms</h2>

        {rooms === undefined ? (
          <div role="status" className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            <span className="sr-only">Looking for rooms…</span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="aspect-square animate-pulse rounded-[20px] bg-white/8" />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <div className="panel flex max-w-xl animate-pop flex-col items-start gap-4 rounded-[20px] p-6">
            <Discs className="flex" />
            <div className="flex flex-col gap-1">
              <h3 className="text-xl font-bold tracking-tight">No rooms open yet</h3>
              <p className="text-muted-foreground">
                Use the button above and others on this network will see your room here.
              </p>
            </div>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {rooms.map((room, index) => (
              <li
                key={room.code}
                className="animate-rise"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                {/* The whole tile is the link: it is the only thing to do
                    with a room, and a small target on a phone is a miss. */}
                <Link
                  href={`/room/${room.code}${room.hasPasscode ? '?locked=1' : ''}`}
                  className="group flex flex-col gap-2.5 rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                >
                  <span className="panel relative block aspect-square overflow-hidden rounded-[20px] transition-transform duration-500 ease-soft group-hover:-translate-y-0.5 group-active:scale-[0.98]">
                    <Cover
                      title={room.roomName}
                      className="size-full transition-transform duration-700 ease-soft group-hover:scale-105"
                    />
                    <span aria-hidden className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/70 to-transparent" />
                    <span className="absolute inset-x-4 bottom-4 flex items-end justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-2xl leading-tight font-bold tracking-tight text-white">
                        <span className="line-clamp-2 break-words">{room.roomName}</span>
                        {room.hasPasscode && <Lock aria-label="Needs a passcode" className="size-4 shrink-0" />}
                      </span>
                    </span>
                    <span className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-xs font-semibold text-white">
                      {room.mode === 'talk' ? (
                        <>
                          <Mic className="size-3.5 text-chart-1" />
                          talking
                        </>
                      ) : (
                        <>
                          {room.nowPlaying ? <Equalizer className="h-3 text-chart-1" /> : null}
                          music
                        </>
                      )}
                    </span>
                  </span>
                  <span className="flex flex-col px-1 text-sm leading-snug">
                    <span className="truncate">
                      {room.mode === 'music' && room.nowPlaying ? `playing ${room.nowPlaying}` : room.description || 'Open room'}
                    </span>
                    <span className="text-muted-foreground">
                      {room.memberCount} {room.memberCount === 1 ? 'person' : 'people'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

/** Three overlapping covers, tilted: the empty room list's picture. Decoration. */
function Discs({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('items-center', className)}>
      {['late night', 'sunrise', 'rave'].map((title, i) => (
        <Cover
          key={title}
          title={title}
          className={cn(
            'size-20 rounded-2xl shadow-lg ring-4 ring-background md:size-28',
            i > 0 && '-ml-6',
            ['-rotate-6', 'rotate-3 -translate-y-2', '-rotate-2'][i],
          )}
        />
      ))}
      <Equalizer className="ml-4 h-6 text-ring" />
    </div>
  );
}
