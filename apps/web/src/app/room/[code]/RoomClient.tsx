'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Disc3,
  DoorOpen,
  LoaderCircle,
  Music,
  Pause,
  Play,
  RotateCcw,
  Square,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { getRoom, subscribeRoom } from '@/lib/session';
import type { Ended, PlaylistItem } from '@/lib/room';
import { POSITION_TICK_MS } from '@/lib/player';
import { encodePasscode } from '@/lib/passcode';
import { loadUserOffset, saveUserOffset } from '@/lib/offset';
import { keepAwake, onHidden } from '@/lib/wake';
import { Roster } from '@/components/Roster';
import { DebugOverlay } from '@/components/DebugOverlay';
import { OffsetSlider } from '@/components/OffsetSlider';
import { TrackProgress } from '@/components/TrackProgress';
import { Button, buttonVariants } from '@/components/ui/button';
import { Equalizer } from '@/components/Equalizer';
import { cn } from '@/lib/utils';
import { ShareDialog } from '@/components/ShareDialog';
import { PreJoin } from './PreJoin';

/**
 * The room, on screen.
 *
 * Everything the room does — the mesh, the playlist, the clock, the cues — is
 * the LiveRoom's. This reads its snapshot and passes on what a person taps,
 * so nothing here can change what plays or when; the effects below are the
 * screen's own business: toasts, a progress tick, the wake lock.
 */
export function RoomClient() {
  const params = useParams<{ code: string }>();
  // The overlay is absent without the param, not hidden: it re-renders several
  // times a second and has no business existing in a normal session.
  const search = useSearchParams();
  const debug = search?.get('debug') === '1';
  const room = useSyncExternalStore(subscribeRoom, getRoom, () => undefined);
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => room?.subscribe(listener) ?? (() => {}), [room]),
    () => room?.snapshot(),
    () => undefined,
  );

  const peers = snapshot?.peers;
  const transfers = snapshot?.transfers;
  const selfPeerId = snapshot?.selfPeerId;
  const isCreator = snapshot?.isCreator ?? false;
  const ended = snapshot?.ended;
  const playing = snapshot?.playing ?? false;
  const currentTrackId = snapshot?.currentTrackId;

  // Saying the host left would send someone off to blame a person when the
  // fix is their own wifi — so a dropped socket gets its own word, and the
  // same sentence the panel shows: two copies of this drift the moment one
  // of them is reworded.
  useEffect(() => {
    if (ended === 'lost-connection') toast.error(ENDED_MESSAGE[ended]);
  }, [ended]);

  // Who was here last render. A ref, not state: it exists to be diffed
  // against, and writing it must not itself cause a render.
  const knownPeers = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (!peers) return;
    const now = new Set(peers.map((p) => p.peerId));
    const before = knownPeers.current;
    knownPeers.current = now;
    // The first roster is everyone already here, including ourselves. Nobody
    // "joined" — announcing four arrivals on entry is noise, not news.
    if (!before) return;
    for (const peer of peers) {
      if (!before.has(peer.peerId)) toast(`${peer.displayName} joined`);
    }
  }, [peers]);

  // Stalled is a transition, not a state: the roster already shows the badge
  // for as long as it lasts, so a toast per render would be a stream of them.
  const stalled = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!transfers) return;
    const now = new Set(
      [...transfers].filter(([, t]) => t.state === 'stalled').map(([peerId]) => peerId),
    );
    for (const peerId of now) {
      if (stalled.current.has(peerId)) continue;
      // Both sides mark stalled, but a joiner's map holds only itself — being
      // told "Ada has stopped downloading" when you are Ada is nonsense. The
      // creator is the one who has to decide whether to wait.
      if (peerId === selfPeerId) continue;
      const name = peers?.find((p) => p.peerId === peerId)?.displayName ?? 'A peer';
      toast.warning(`${name} has stopped downloading.`);
    }
    stalled.current = now;
  }, [transfers, peers, selfPeerId]);

  // Position is derived from the audio clock rather than pushed, so nothing
  // notifies when it moves — without a tick the bar sits still between cues.
  // Only while playing: a paused track cannot change position, so polling it
  // would re-render the room several times a second to redraw the same bar.
  const [positionSeconds, setPositionSeconds] = useState(0);
  useEffect(() => {
    if (!room) return;
    // Once on every change of `playing` too: where a pause landed is not
    // where the last tick left the bar.
    const read = () => setPositionSeconds(room.position());
    queueMicrotask(read);
    if (!playing) return;
    const timer = setInterval(read, POSITION_TICK_MS);
    return () => clearInterval(timer);
  }, [room, playing, currentTrackId]);

  // Read far faster than it is corrected, and only with the overlay open.
  // Sampling on the correction cadence would show the drift exactly when it
  // is smallest — a number that never moves, hiding the excursion between
  // the corrections, which is the one thing the overlay exists to show.
  const [driftMs, setDriftMs] = useState(0);
  useEffect(() => {
    if (!room || !debug) return;
    const timer = setInterval(() => setDriftMs(room.drift()), 250);
    return () => clearInterval(timer);
  }, [room, debug]);

  // Lazily, because localStorage is not there during the server render.
  const [userOffsetMs, setUserOffsetMs] = useState(() => loadUserOffset());
  // The stored value has to reach a room that appears after it was read.
  useEffect(() => {
    room?.setUserOffset(userOffsetMs);
  }, [room, userOffsetMs]);
  const changeUserOffset = useCallback((value: number) => {
    setUserOffsetMs(value);
    saveUserOffset(value);
  }, []);

  // Every device stays awake, not only the creator: a phone that auto-locks
  // stops running the page, so it can no longer hear a pause or correct its
  // drift — and on iOS it used to go silent outright.
  const inRoom = snapshot !== undefined && !ended;
  useEffect(() => {
    if (!inRoom) return;
    return keepAwake();
  }, [inRoom]);

  // The creator keeps the room alive by staying visible. This does not
  // prevent a backgrounded tab — it makes it visible and less likely.
  useEffect(() => {
    if (!isCreator || ended) return;
    return onHidden(() =>
      toast.warning('Keep this tab open. This device is the clock for the room.'),
    );
  }, [isCreator, ended]);

  // A bad file among several: the good ones are in, and this says which
  // kind of thing went wrong with the rest.
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Built from the origin and path, not the whole address: the query is
  // this tab's own business (`?debug=1`), and the passcode rides in the
  // fragment, which never reaches the web server. The right origin is
  // whatever this tab was actually opened on — the LAN URL when the creator
  // used the one `make dev` printed; a baked-in host would go stale the next
  // time DHCP moves the IP.
  //
  // Through a store subscription rather than an effect because there is no
  // `window` during the server render.
  const passcode = snapshot?.passcode;
  const joinUrl = useSyncExternalStore(
    // Never changes for the life of this mount, so the subscribe is a no-op.
    () => () => {},
    () =>
      `${window.location.origin}${window.location.pathname}` +
      (passcode ? `#p=${encodePasscode(passcode)}` : ''),
    // The server has no location, and rendering a QR to a guessed host would
    // be worse than rendering none: undefined hides it until hydration.
    () => undefined,
  );

  // No room means a refresh or a pasted link — the tap that arms audio has
  // not happened, so this is where it happens.
  const code = params?.code?.toUpperCase();
  if (!room || !snapshot) {
    return code ? <PreJoin code={code} locked={search?.get('locked') === '1'} /> : null;
  }

  const current = snapshot.playlist.find((t) => t.id === snapshot.currentTrackId);

  async function addTracks(files: FileList | null) {
    if (!room || !files || files.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await room.addTracks([...files]);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'That file could not be added.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
      {debug && (
        <DebugOverlay
          estimate={snapshot.estimate}
          driftMs={driftMs}
          connections={snapshot.connections}
          selfPeerId={snapshot.selfPeerId}
          isCreator={isCreator}
        />
      )}
      <header className="flex animate-rise flex-col gap-2">
        <Link
          href="/"
          className="flex h-11 items-center gap-2 self-start text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Rooms
        </Link>
        <h1 className="text-4xl font-extrabold break-words sm:text-5xl">{snapshot.roomName}</h1>
        {snapshot.description && (
          <p className="max-w-[60ch] text-lg text-muted-foreground">{snapshot.description}</p>
        )}
      </header>

      {snapshot.ended ? (
        // The roster behind this has no socket keeping it true, so it goes
        // rather than sitting there looking live next to the bad news.
        <div className={cn(CARD, 'max-w-md animate-pop items-start')}>
          <DoorOpen className="size-8 text-destructive" />
          <p role="alert" className="text-lg font-semibold">
            {ENDED_MESSAGE[snapshot.ended]}
          </p>
          <Link href="/" className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft />
            Back to rooms
          </Link>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            {/* The one loud thing on the screen, and only while there is
                something to be loud about. */}
            <section
              className={cn(
                CARD,
                'animate-rise [animation-delay:60ms]',
                current && 'border-primary bg-primary text-primary-foreground',
              )}
            >
              <h2 className="flex items-center gap-2 font-bold">
                <Disc3
                  className={cn('size-5', playing && 'animate-spin [animation-duration:2.4s]')}
                />
                Now playing
              </h2>
              {current ? (
                <>
                  <p className="flex min-w-0 items-center gap-3 text-2xl font-extrabold sm:text-3xl">
                    <Equalizer playing={playing} className="h-6 gap-1" />
                    <span className="truncate">{current.title}</span>
                  </p>
                  {/* Shown to listeners too: it is the only sign a member has
                      that their silent device is in fact playing. */}
                  {snapshot.currentDuration !== undefined ? (
                    <TrackProgress
                      positionSeconds={positionSeconds}
                      durationSeconds={snapshot.currentDuration}
                      playing={playing}
                    />
                  ) : (
                    <p className="flex items-center gap-2 text-sm">
                      <LoaderCircle className="size-4 animate-spin" />
                      {current.state === 'ready' ? 'Getting ready…' : 'Still downloading this track…'}
                    </p>
                  )}
                  {isCreator && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="w-full bg-primary-foreground text-primary sm:w-auto sm:flex-1"
                        disabled={snapshot.currentDuration === undefined}
                        onClick={() => (playing ? room.pause() : room.resume())}
                      >
                        {playing ? <Pause /> : <Play />}
                        {playing ? 'Pause' : positionSeconds > 0 ? 'Resume' : 'Play'}
                      </Button>
                      <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={() => room.restart()}>
                        <RotateCcw />
                        Restart
                      </Button>
                      <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={() => room.stop()}>
                        <Square />
                        Stop
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">
                  {isCreator
                    ? 'Nothing yet. Add a track below, then press play on it.'
                    : 'Nothing yet. The host picks what plays.'}
                </p>
              )}
            </section>

            <section className={cn(CARD, 'animate-rise [animation-delay:120ms]')}>
              <h2 className="flex items-center gap-2 font-bold">
                <Music className="size-5" />
                Playlist
              </h2>
              {snapshot.playlist.length > 0 && (
                <ol className="flex flex-col gap-2">
                  {snapshot.playlist.map((track, index) => {
                    const isCurrent = track.id === snapshot.currentTrackId;
                    return (
                      <li
                        key={track.id}
                        className={cn(
                          'flex animate-pop flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted py-2 pr-2 pl-4',
                          isCurrent && 'ring-2 ring-primary',
                        )}
                      >
                        <span className="w-5 shrink-0 text-sm tabular-nums text-muted-foreground">
                          {isCurrent ? <Equalizer playing={playing} className="text-primary" /> : index + 1}
                        </span>
                        <span className={cn('min-w-0 flex-1 truncate', isCurrent && 'font-bold')}>
                          {track.title}
                        </span>
                        {isCreator ? (
                          <span className="flex w-full shrink-0 items-center justify-end gap-1 sm:w-auto">
                            <Button
                              type="button"
                              size="icon"
                              aria-label={`Play ${track.title}`}
                              onClick={() => void room.playTrack(track.id)}
                            >
                              <Play />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Move ${track.title} up`}
                              disabled={index === 0}
                              onClick={() => room.moveTrack(track.id, -1)}
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Move ${track.title} down`}
                              disabled={index === snapshot.playlist.length - 1}
                              onClick={() => room.moveTrack(track.id, 1)}
                            >
                              <ChevronDown />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${track.title}`}
                              onClick={() => room.removeTrack(track.id)}
                            >
                              <X />
                            </Button>
                          </span>
                        ) : (
                          <DownloadStatus track={track} />
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {isCreator ? (
                <>
                  {/* The input is there and focusable, only not drawn: the
                      label is what is seen, and it shows the input's focus. */}
                  <label
                    htmlFor="add-tracks"
                    className={cn(
                      buttonVariants({ variant: 'outline' }),
                      'cursor-pointer self-start has-focus-visible:ring-2 has-focus-visible:ring-ring has-disabled:pointer-events-none has-disabled:opacity-50',
                    )}
                  >
                    {adding ? <LoaderCircle className="animate-spin" /> : <Upload />}
                    Add tracks
                    <input
                      id="add-tracks"
                      type="file"
                      accept="audio/*"
                      multiple
                      disabled={adding}
                      className="sr-only"
                      onChange={(e) => {
                        void addTracks(e.target.files);
                        // So choosing the same file again still fires a change.
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {adding && <p className="text-sm text-muted-foreground">Checking the file…</p>}
                  {addError && (
                    <p role="alert" className="text-sm font-medium text-destructive">
                      {addError}
                    </p>
                  )}
                </>
              ) : (
                snapshot.playlist.length === 0 && (
                  <p className="text-muted-foreground">The host has not added any tracks yet.</p>
                )
              )}
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            {/* For as long as the room is live: anyone can join at any point. */}
            <section className={cn(CARD, 'animate-rise [animation-delay:180ms]')}>
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-bold">
                  <Users className="size-5" />
                  In the room
                </h2>
                {joinUrl && <ShareDialog url={joinUrl} hasPasscode={passcode !== undefined} />}
              </div>
              <Roster
                peers={snapshot.peers}
                selfPeerId={snapshot.selfPeerId}
                connections={snapshot.connections}
                transfers={snapshot.transfers}
                onKick={isCreator ? (peerId) => room.kick(peerId) : undefined}
              />
              <OffsetSlider valueMs={userOffsetMs} onChange={changeUserOffset} />
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

const CARD =
  'flex flex-col gap-4 rounded-xl border-2 border-border bg-card p-5 text-card-foreground shadow-md sm:p-6';

/** Where one track stands on this member's device. */
function DownloadStatus({ track }: { track: PlaylistItem }) {
  const className = 'flex h-10 shrink-0 items-center gap-1.5 pr-2 text-sm';
  if (track.state === 'ready') {
    return (
      <span className={className}>
        <Check className="size-4 animate-pop text-primary" />
        ready
      </span>
    );
  }
  if (track.state === 'waiting') {
    return <span className={cn(className, 'text-muted-foreground')}>waiting</span>;
  }
  return (
    <span className={cn(className, 'tabular-nums text-muted-foreground')}>
      <LoaderCircle className="size-4 animate-spin" />
      {Math.round((track.progress ?? 0) * 100)}%
    </span>
  );
}

const ENDED_MESSAGE: Record<Ended, string> = {
  'creator-left': 'This room has ended. The person who created it left.',
  'room-empty': 'This room has ended. Everyone else left.',
  'lost-connection': 'Lost the connection to this room. Check the network and rejoin.',
  kicked: 'You were removed from this room by its host.',
};
