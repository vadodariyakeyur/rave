'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import type { Peer } from '@rave/protocol';
import { getRoom, subscribeRoom } from '@/lib/session';
import type { Ended } from '@/lib/room';
import { POSITION_TICK_MS } from '@/lib/player';
import { loadUserOffset, saveUserOffset } from '@/lib/offset';
import { keepAwake, onHidden } from '@/lib/wake';
import { Roster } from '@/components/Roster';
import { DebugOverlay } from '@/components/DebugOverlay';
import { OffsetSlider } from '@/components/OffsetSlider';
import { TrackProgress, formatDuration } from '@/components/TrackProgress';
import { Button } from '@/components/ui/button';
import { ForceStartDialog } from '@/components/ForceStartDialog';
import { JoinQr } from '@/components/JoinQr';
import { PreJoin } from './PreJoin';

/**
 * The room, on screen.
 *
 * Everything the room does — the mesh, the file, the clock, the cues — is
 * the LiveRoom's. This reads its snapshot and passes on what a person taps,
 * so nothing here can change what plays or when; the effects below are the
 * screen's own business: toasts, a progress tick, the wake lock.
 */
export function RoomClient() {
  const params = useParams<{ code: string }>();
  // The overlay is absent without the param, not hidden: it re-renders several
  // times a second and has no business existing in a normal session.
  const debug = useSearchParams()?.get('debug') === '1';
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

  // The roster at the moment the dialog opened, not at the moment it renders.
  // A peer going ready (or stalling) while the creator reads the dialog would
  // otherwise rewrite the list under them — and the dangerous direction is
  // silent: a peer who stalls after it opens is never named, then dropped.
  const [confirming, setConfirming] = useState<readonly Peer[] | undefined>(undefined);

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
  }, [room, playing]);

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

  // The creator keeps the room alive by staying visible. Neither of these
  // prevents a backgrounded tab — they make it visible and less likely.
  useEffect(() => {
    if (!isCreator || ended) return;
    const release = keepAwake();
    const stop = onHidden(() =>
      toast.warning('Keep this tab open — this device is the clock for the room.'),
    );
    return () => {
      release();
      stop();
    };
  }, [isCreator, ended]);

  // Read from the browser rather than built from a configured host: the
  // right link is whatever origin this tab was actually opened on, which is
  // the LAN URL when the creator used the one `make dev` printed. A phone
  // scanning a `localhost` code reaches nothing, and showing that plainly is
  // the honest signal that the creator opened the wrong URL — a baked-in
  // NEXT_PUBLIC host would instead go stale the next time DHCP moves the IP.
  //
  // Through a store subscription rather than an effect because there is no
  // `window` during the server render: this is a read of an external value
  // with a server snapshot, which is exactly what the hook is for.
  const joinUrl = useSyncExternalStore(
    // Never changes for the life of this mount — a navigation remounts the
    // route — so the subscribe is a no-op rather than a listener nobody fires.
    () => () => {},
    () => window.location.href,
    // The server has no location, and rendering a QR to a guessed host would
    // be worse than rendering none: undefined hides it until hydration.
    () => undefined,
  );

  // No room means a refresh or a pasted link — the tap that arms audio has
  // not happened, so this is where it happens.
  const code = params?.code?.toUpperCase();
  if (!room || !snapshot) return code ? <PreJoin code={code} /> : null;

  // The server's flag, not our own view of it: a peer we cannot see is still
  // in the room, and the barrier is the whole room's business. An empty room
  // is not "everyone ready" — every() says true for nobody, and a creator
  // alone would get a lit button with no one to play to.
  const everyoneReady = snapshot.peers.length > 1 && snapshot.peers.every((p) => p.ready);
  // Named, not counted: "2 peers" tells the creator nothing about whether to
  // wait, and the whole point of the dialog is that they recognise the device.
  const notReady = snapshot.peers.filter((p) => !p.ready);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 p-8">
      {debug && (
        <DebugOverlay
          estimate={snapshot.estimate}
          driftMs={driftMs}
          connections={snapshot.connections}
          selfPeerId={snapshot.selfPeerId}
          isCreator={isCreator}
        />
      )}
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">{snapshot.roomName}</p>
        <h1 className="font-mono text-4xl font-semibold tracking-[0.2em]">{snapshot.code}</h1>
        {snapshot.track && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {snapshot.track.fileName} · {formatDuration(snapshot.track.durationSeconds)}
          </p>
        )}
        {/* Only while the room still takes joins, and only once the origin is
            known. A locked room refuses new peers, so the code below it is the
            record of which room this is, not an invitation. */}
        {!snapshot.locked && !snapshot.ended && joinUrl && (
          <div className="mt-3">
            <JoinQr url={joinUrl} />
          </div>
        )}
      </header>

      {snapshot.ended ? (
        // The roster behind this has no socket keeping it true, so it goes
        // rather than sitting there looking live next to the bad news.
        <p
          role="alert"
          className="rounded-md border border-[var(--color-destructive)] p-3 text-sm text-[var(--color-destructive)]"
        >
          {ENDED_MESSAGE[snapshot.ended]}
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-[var(--color-muted-foreground)]">
            In the room
          </h2>
          {/* Once the room is locked there is a track to be somewhere in.
              Shown to listeners too, not just the creator: it is the only
              sign a peer has that their silent device is in fact playing. */}
          {snapshot.locked && snapshot.track && (
            <TrackProgress
              positionSeconds={positionSeconds}
              durationSeconds={snapshot.track.durationSeconds}
              playing={playing}
            />
          )}
          <Roster
            peers={snapshot.peers}
            selfPeerId={snapshot.selfPeerId}
            connections={snapshot.connections}
            transfers={snapshot.transfers}
          />
          <OffsetSlider valueMs={userOffsetMs} onChange={changeUserOffset} />
          {isCreator && (
            <>
              <Button
                type="button"
                // Alone in the room there is nobody to play to; with someone
                // stuck the button still works, it just asks first. Once the
                // room is locked the same button runs the track — the server
                // has already had its say, and the rest is cues on the wire.
                disabled={snapshot.peers.length < 2}
                onClick={() => {
                  if (snapshot.locked) return playing ? room.pause() : room.play();
                  if (everyoneReady) return room.start(false);
                  setConfirming(notReady);
                }}
              >
                {!snapshot.locked ? 'Play' : playing ? 'Pause' : 'Resume'}
              </Button>
              {snapshot.locked ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Started. The room is closed to new joins.
                </p>
              ) : (
                !everyoneReady &&
                snapshot.peers.length > 1 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Waiting for everyone to finish downloading.
                  </p>
                )
              )}
              <ForceStartDialog
                notReady={confirming}
                onCancel={() => setConfirming(undefined)}
                onConfirm={() => {
                  setConfirming(undefined);
                  room.start(true);
                }}
              />
            </>
          )}
        </section>
      )}
    </main>
  );
}

const ENDED_MESSAGE: Record<Ended, string> = {
  'creator-left': 'This room has ended. The person who created it left.',
  'room-empty': 'This room has ended. Everyone else left.',
  'lost-connection': 'Lost the connection to this room. Check the network and rejoin.',
  excluded: 'The room started without you. Your download had not finished in time.',
};
