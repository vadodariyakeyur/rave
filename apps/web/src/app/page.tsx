'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Mic } from 'lucide-react';
import type { RoomSummary } from '@rave/protocol';
import { Backdrop } from '@/components/Backdrop';
import { Cover, glowOf } from '@/components/Cover';
import { Tag } from '@/components/Tag';
import { Equalizer } from '@/components/Equalizer';
import { JoinCode } from '@/components/JoinCode';
import { Header, Shell } from '@/components/Shell';
import { buttonVariants } from '@/components/ui/button';
import { Signaling } from '@/lib/signaling';
import { cn } from '@/lib/utils';

/**
 * Every live room, kept current for as long as the page is open.
 *
 * A headline block, then every room as a full-width row, with the one action
 * (create a room) stuck to the bottom.
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

  const listening = rooms?.reduce((n, r) => n + r.memberCount, 0) ?? 0;
  const ticker = `LIVE NOW · ${rooms?.length ?? 0} ROOMS · ${listening} LISTENING · SAME SECOND, EVERY PHONE · `;

  return (
    <Shell
      backdrop={<Backdrop title="party" calm />}
      header={<Header />}
      cta={
        <Link href="/create" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Create room
        </Link>
      }
      banner={
        rooms !== undefined && (
          <div className="overflow-hidden bg-chart-3 py-2 text-background">
            {/* Read once: the repeat is decoration. */}
            <p className="sr-only">{ticker}</p>
            <div aria-hidden className="flex w-max animate-marquee font-display text-lg whitespace-nowrap uppercase">
              <span className="pr-8">{ticker.repeat(4)}</span>
              <span className="pr-8">{ticker.repeat(4)}</span>
            </div>
          </div>
        )
      }
      aside={
        <>
          <section className="plunk block-lime mr-[3px] mb-[3px] flex animate-rise flex-col gap-3 overflow-visible p-5">
            <h1 className="font-display text-[2.5rem] leading-[0.95] tracking-tight lg:text-[3.5rem]">
              Every phone, one speaker.
            </h1>
            <p className="max-w-[26ch] font-semibold">
              Add tracks, share the link, and everyone hears the same second at the same time.
            </p>
            <Discs className="flex pt-2" />
          </section>
          {rooms !== undefined && (
            <dl className="grid grid-cols-3 gap-3">
              {[
                [rooms.length, 'rooms', 'block-green'],
                [listening, 'listening', 'block-yellow'],
                ['0', 'ms drift', 'block-lime'],
              ].map(([n, label, face]) => (
                <div key={label} className={cn('plunk mr-[3px] mb-[3px] flex flex-col p-3', face as string)}>
                  <dd className="font-display text-4xl leading-none">{n}</dd>
                  <dt className="text-[0.6875rem] font-extrabold tracking-wider uppercase">{label}</dt>
                </div>
              ))}
            </dl>
          )}
          <JoinCode />
        </>
      }
    >
      <section aria-labelledby="live-rooms" className="flex flex-col gap-3">
        <h2 id="live-rooms" className="font-display text-2xl tracking-tight uppercase">
          Live rooms{rooms ? ` · ${rooms.length}` : ''}
        </h2>

        {rooms === undefined ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">Looking for rooms…</span>
            {['bg-ring/15', 'bg-chart-1/15', 'bg-chart-3/15'].map((tint) => (
              <div key={tint} className={cn('h-24 animate-pulse', tint)} />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <div className="plunk block-green mr-[3px] mb-[3px] flex animate-pop flex-col items-start gap-4 p-5">
            <h3 className="font-display text-4xl leading-none">Be the first room.</h3>
            <p className="font-semibold">Use the button below and others on this network will see your room here.</p>
            <ol className="grid w-full grid-cols-3 gap-2 text-sm font-extrabold uppercase">
              {['Create', 'Share', 'Hear it together'].map((step, i) => (
                <li key={step} className="flex flex-col gap-1 border-t-2 border-background pt-2">
                  <span aria-hidden className="font-display text-2xl leading-none">
                    0{i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {rooms.map((room, index) => (
              <li
                key={room.code}
                className={cn('animate-rise', index === 0 && 'lg:col-span-2')}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                {/* The whole row is the link: it is the only thing to do
                    with a room, and a small target on a phone is a miss. */}
                <Link
                  href={`/room/${room.code}${room.hasPasscode ? '?locked=1' : ''}`}
                  style={{
                    borderLeft: `6px solid ${glowOf(room.roomName)[0]}`,
                  }}
                  className={cn(
                    'flex items-center gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    index === 0 ? 'plunk block-yellow mr-[3px] mb-[3px] p-4' : 'flat p-3',
                  )}
                >
                  <Cover title={room.roomName} className={cn('shrink-0', index === 0 ? 'size-20' : 'size-14')} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                    <span className="truncate font-display text-xl">{room.roomName}</span>
                    <span className="flex items-center gap-1.5 text-sm">
                      {room.mode === 'talk' ? (
                        <Mic className="size-3.5 shrink-0" />
                      ) : room.nowPlaying ? (
                        <Equalizer className="h-3 shrink-0" />
                      ) : null}
                      <span className="truncate">
                        {room.mode === 'talk' ? 'talking' : room.nowPlaying || room.description || 'music'}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Tag tone={room.mode === 'talk' ? 'talk' : 'music'}>
                        {room.mode === 'talk' ? 'Talk' : 'Music'}
                      </Tag>
                      {room.hasPasscode && <Tag tone="locked">Locked</Tag>}
                      <span className="flex items-center gap-1.5 text-sm">
                        <span
                          aria-hidden
                          className="size-2 animate-pulse rounded-full bg-chart-1 motion-reduce:animate-none"
                        />
                        {room.memberCount} {room.memberCount === 1 ? 'person' : 'people'}
                      </span>
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-5 shrink-0" />
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
            'size-14 rounded-none shadow-lg ring-4 ring-background lg:size-20',
            i > 0 && '-ml-6',
            ['-rotate-6', 'rotate-3 -translate-y-2', '-rotate-2'][i],
          )}
        />
      ))}
      <Equalizer className="ml-4 h-6 text-background" />
    </div>
  );
}
