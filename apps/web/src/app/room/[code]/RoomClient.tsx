'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, DoorOpen, Headphones, ListMusic, Mic, MicOff, Music, Users } from 'lucide-react';
import type { Mode } from '@rave/protocol';
import { getRoom, subscribeRoom } from '@/lib/session';
import type { Ended } from '@/lib/room';
import type { VoiceState } from '@/lib/voice';
import { POSITION_TICK_MS } from '@/lib/player';
import { loadUserOffset, saveUserOffset } from '@/lib/offset';
import { encodePasscode } from '@/lib/passcode';
import { keepAwake, onHidden } from '@/lib/wake';
import { Avatar } from '@/components/Avatar';
import { SpeakerBackdrop } from '@/components/SpeakerBackdrop';
import { Roster } from '@/components/Roster';
import { Header, Shell, useWide } from '@/components/Shell';
import { DebugOverlay } from '@/components/DebugOverlay';
import { OffsetSlider } from '@/components/OffsetSlider';
import { Queue } from '@/components/Queue';
import { Reactions } from '@/components/Reactions';
import { ShareDialog } from '@/components/ShareDialog';
import { Sheet } from '@/components/Sheet';
import { Tag } from '@/components/Tag';
import { Stage, Transport } from '@/components/Stage';
import { TalkGrid } from '@/components/TalkGrid';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
    const now = new Set([...transfers].filter(([, t]) => t.state === 'stalled').map(([peerId]) => peerId));
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
    return onHidden(() => toast.warning('Keep this tab open. This device is the clock for the room.'));
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
    () => `${window.location.origin}${window.location.pathname}` + (passcode ? `#p=${encodePasscode(passcode)}` : ''),
    // The server has no location, and rendering a QR to a guessed host would
    // be worse than rendering none: undefined hides it until hydration.
    () => undefined,
  );

  // Files dropped anywhere on the music screen, for the creator.
  const [dragging, setDragging] = useState(false);

  // Which sheet is open.
  const [sheet, setSheet] = useState<'playlist' | 'people' | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  // From 1024px the playlist and the people are panels beside the stage, not sheets.
  const wide = useWide();

  // No room means a refresh or a pasted link — the tap that arms audio has
  // not happened, so this is where it happens.
  const code = params?.code?.toUpperCase();
  if (!room || !snapshot) {
    return code ? <PreJoin code={code} locked={search?.get('locked') === '1'} /> : null;
  }

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

  const names = new Map(snapshot.peers.map((p) => [p.peerId, p.displayName]));
  const current =
    snapshot.mode === 'music' ? snapshot.playlist.find((t) => t.id === snapshot.currentTrackId) : undefined;
  const self = snapshot.peers.find((p) => p.peerId === snapshot.selfPeerId);
  const talk = snapshot.mode === 'talk';
  const people = `${snapshot.peers.length} ${snapshot.peers.length === 1 ? 'person' : 'people'}`;

  let cta: React.ReactNode;
  if (!snapshot.ended) {
    if (talk) {
      cta = (
        <>
          {snapshot.voice.micOn ? (
            <Button
              type="button"
              size="lg"
              className="flex-1"
              variant={snapshot.voice.muted ? 'outline' : 'default'}
              aria-pressed={snapshot.voice.muted}
              onClick={() => room.setMuted(!snapshot.voice.muted)}
            >
              {snapshot.voice.muted ? <MicOff /> : <Mic />}
              {snapshot.voice.muted ? 'Unmute' : 'Mute'}
            </Button>
          ) : (
            <Button type="button" size="lg" className="flex-1" onClick={() => void room.enableMic()}>
              <Mic />
              Turn on microphone
            </Button>
          )}
          <Reactions room={room} names={names} className="flex gap-1" />
        </>
      );
    } else if (isCreator) {
      cta = <Transport room={room} snapshot={snapshot} positionSeconds={positionSeconds} />;
    } else {
      cta = <p className="w-full text-center text-sm text-muted-foreground">The host picks what plays.</p>;
    }
  }

  const queue = (
    <Queue
      room={room}
      snapshot={snapshot}
      adding={adding}
      addError={addError}
      onFiles={(files) => void addTracks(files)}
      className="min-h-0 flex-1"
    />
  );
  const modeSwitch = (
    <ModeSwitch mode={snapshot.mode} onChange={isCreator ? (mode) => room.setMode(mode) : undefined} />
  );
  const audioDelay = (
    <section aria-label="My audio delay" className="flex flex-col gap-3">
      <p className="flex items-center gap-2.5 leading-tight">
        <Avatar name={self?.displayName ?? '?'} size="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{self?.displayName}</span>
          <span className="text-xs text-muted-foreground">{isCreator ? 'host' : 'member'}</span>
        </span>
      </p>
      <OffsetSlider valueMs={userOffsetMs} onChange={changeUserOffset} />
    </section>
  );
  const peopleBody = (
    <Roster
      peers={snapshot.peers}
      selfPeerId={snapshot.selfPeerId}
      connections={snapshot.connections}
      transfers={snapshot.transfers}
      speaking={talk ? snapshot.voice.speaking : undefined}
      selfMuted={talk && snapshot.voice.micOn && snapshot.voice.muted}
      onKick={isCreator ? (peerId) => room.kick(peerId) : undefined}
    />
  );

  return (
    <Shell
      backdrop={
        <SpeakerBackdrop
          talk={talk}
          speaker={[...snapshot.voice.speaking].map((id) => names.get(id)).find(Boolean)}
          fallback={current?.title ?? snapshot.roomName}
          art={current?.art}
          idle={!(snapshot.mode === 'music' && snapshot.playing)}
        />
      }
      header={
        <Header
          back="/"
          title={snapshot.code}
          actions={joinUrl && <ShareDialog url={joinUrl} code={snapshot.code} hasPasscode={passcode !== undefined} />}
        />
      }
      cta={cta}
      aside={
        <>
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <p className="plunk block-lime mr-[3px] mb-[3px] px-3 py-1 font-display text-2xl leading-none tracking-wider">
                <span className="sr-only">Room code </span>
                {snapshot.code}
              </p>
              <Tag tone={talk ? 'talk' : 'music'}>{talk ? 'Talk' : 'Music'}</Tag>
              {isCreator && <Tag tone="host">Host</Tag>}
            </div>
            <h1 className="font-display text-[2rem] leading-[0.95] lg:text-[2.5rem] tracking-tight break-words">
              {snapshot.roomName}
            </h1>
            <p className="text-muted-foreground">
              {people}
              {snapshot.description && ` · ${snapshot.description}`}
            </p>
          </section>
          {!snapshot.ended && (
            <>
              {/* Plunk edges sit outside the tile, hence the right margin. */}
              <div className="grid grid-cols-2 gap-5 pr-(--plunk) pb-(--plunk) lg:hidden">
                <button type="button" className={cn(TILE, 'block-yellow')} onClick={() => setSheet('playlist')}>
                  <ListMusic className="size-5" />
                  {talk ? 'Settings' : 'Playlist'}
                  <span className="font-display text-2xl">{talk ? '·' : snapshot.playlist.length}</span>
                </button>
                <button type="button" className={cn(TILE, 'block-pink')} onClick={() => setSheet('people')}>
                  <Users className="size-5" />
                  People
                  <span className="font-display text-2xl">{snapshot.peers.length}</span>
                </button>
              </div>
            </>
          )}
          {wide && !snapshot.ended && (
            <>
              <section aria-label="In the room" className="flat flex flex-col gap-4 p-5">
                <h2 className="text-[0.8125rem] font-extrabold tracking-wide uppercase">In the room</h2>
                {peopleBody}
              </section>
              <div className="flat flex flex-col gap-4 p-5">
                {modeSwitch}
                {audioDelay}
              </div>
            </>
          )}
        </>
      }
    >
      {debug && (
        <DebugOverlay
          estimate={snapshot.estimate}
          driftMs={driftMs}
          connections={snapshot.connections}
          selfPeerId={snapshot.selfPeerId}
          isCreator={isCreator}
        />
      )}

      {snapshot.ended ? (
        // The roster behind this has no socket keeping it true, so it goes
        // rather than sitting there looking live next to the bad news.
        <div className={cn(CARD, 'plunk block-pink mr-[3px] mb-[3px] animate-pop items-start')}>
          <DoorOpen className="size-14" />
          <p role="alert" className="font-display text-3xl leading-tight">
            {ENDED_MESSAGE[snapshot.ended]}
          </p>
          <Link
            href="/"
            className={buttonVariants({
              variant: 'outline',
              className: 'border-background bg-transparent text-background hover:bg-background/15',
            })}
          >
            <ArrowLeft />
            Back to rooms
          </Link>
        </div>
      ) : (
        <>
          {talk ? (
            <>
              <TalkPanel voice={snapshot.voice} people={snapshot.peers.length} />
              <TalkGrid
                peers={snapshot.peers}
                selfPeerId={snapshot.selfPeerId}
                connections={snapshot.connections}
                speaking={snapshot.voice.speaking}
                selfMuted={snapshot.voice.micOn && snapshot.voice.muted}
                onKick={isCreator ? (peerId) => room.kick(peerId) : undefined}
              />
              {snapshot.peers.length === 1 && (
                <p className="flat p-4 font-semibold">
                  Waiting for others. Share the link or the code {snapshot.code}.
                </p>
              )}
            </>
          ) : (
            <div
              className={cn(
                'relative flex min-w-0 shrink-0 flex-col gap-4 transition-shadow',
                dragging && 'ring-4 ring-primary ring-offset-4 ring-offset-background',
              )}
              onDragOver={(e) => {
                if (!isCreator || !e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(e) => {
                if (!isCreator) return;
                e.preventDefault();
                setDragging(false);
                void addTracks(e.dataTransfer.files);
              }}
            >
              <Stage compact={wide} room={room} snapshot={snapshot} positionSeconds={positionSeconds} />
            </div>
          )}

          {wide && !talk && <div className="flat flex min-h-0 flex-1 flex-col p-5">{queue}</div>}
          {!wide && (
            <>
              <Sheet title={talk ? 'Settings' : 'Playlist'} open={sheet === 'playlist'} onClose={closeSheet}>
                <div className="flex flex-col gap-4">
                  {modeSwitch}
                  {!talk && queue}
                  {audioDelay}
                </div>
              </Sheet>
              <Sheet title="In the room" open={sheet === 'people'} onClose={closeSheet}>
                {peopleBody}
              </Sheet>
            </>
          )}
        </>
      )}

      {/* Everyone else's voice. Rendered whatever the mode shows, so a
          switch back to music cannot cut a sentence off mid-word. */}
      {[...snapshot.voice.streams].map(([peerId, stream]) => (
        <RemoteVoice key={peerId} stream={stream} />
      ))}
    </Shell>
  );
}

const TILE =
  'plunk plunk-press flex h-14 items-center justify-center gap-2 text-[0.8125rem] font-extrabold tracking-wide uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const CARD = 'flat flex flex-col gap-4 p-5 text-card-foreground sm:p-6';

const ENDED_MESSAGE: Record<Ended, string> = {
  'creator-left': 'This room has ended. The person who created it left.',
  'room-empty': 'This room has ended. Everyone else left.',
  'lost-connection': 'Lost the connection to this room. Check the network and rejoin.',
  kicked: 'You were removed from this room by its host.',
};

/** Music | Talk, as two rows. The creator switches it; everyone else sees which it is. */
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange?: (mode: Mode) => void }) {
  const modes = [
    { mode: 'music', label: 'Music', Icon: Music },
    { mode: 'talk', label: 'Talk', Icon: Mic },
  ] as const;
  if (!onChange) {
    const { label, Icon } = modes.find((m) => m.mode === mode)!;
    return (
      <p
        className={cn(
          'plunk mr-[3px] mb-[3px] flex h-11 items-center gap-2 px-4 text-[0.9375rem] font-extrabold uppercase',
          mode === 'talk' ? 'block-pink' : 'block-yellow',
        )}
      >
        <Icon className="size-5" />
        {label} mode
      </p>
    );
  }
  return (
    <div role="group" aria-label="Room mode" className="grid grid-cols-2 gap-4 pr-(--plunk) pb-(--plunk)">
      {modes.map(({ mode: value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={cn(
            'plunk plunk-press flex h-12 items-center justify-center gap-2 text-sm font-extrabold uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === 'talk' ? 'block-pink' : 'block-yellow',
            mode !== value && 'opacity-50',
            mode === value && 'translate-x-[3px] translate-y-[3px] [&::after]:hidden [&::before]:hidden',
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Past this many people each device is uploading this many streams, and phones feel it. */
const COMFORTABLE_PEOPLE = 8;

/** What talk mode asks of you, and what is wrong when it is not working. */
function TalkPanel({ voice, people }: { voice: VoiceState; people: number }) {
  return (
    <section className="flex animate-rise flex-col gap-2 text-sm text-muted-foreground">
      <p
        aria-live="polite"
        className={cn(
          'plunk mr-[3px] mb-[3px] p-4 font-display text-3xl leading-none uppercase',
          voice.micOn && !voice.muted ? 'block-green' : 'flat border-2 text-foreground',
        )}
      >
        {voice.micOn ? (voice.muted ? 'You are muted' : 'You are live') : 'Listening only'}
      </p>
      <p className="flex items-start gap-2">
        <Headphones className="mt-0.5 size-5 shrink-0" />
        Everyone in this room can hear everyone else. Use headphones: speakers next to an open microphone feed back.
      </p>
      {voice.error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {voice.error}
        </p>
      )}
      {people > COMFORTABLE_PEOPLE && (
        <p>Voice works best with {COMFORTABLE_PEOPLE} people or fewer. Larger rooms may stutter.</p>
      )}
    </section>
  );
}

/** One person's voice, played. Not drawn: it has nothing to show. */
function RemoteVoice({ stream }: { stream: MediaStream }) {
  return (
    <audio
      autoPlay
      playsInline
      ref={(element) => {
        if (element && element.srcObject !== stream) element.srcObject = stream;
      }}
    />
  );
}
