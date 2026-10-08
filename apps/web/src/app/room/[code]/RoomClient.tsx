'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, DoorOpen, Headphones, ListMusic, Mic, MicOff, Music, Settings, Users } from 'lucide-react';
import type { Mode } from '@rave/protocol';
import { getRoom, subscribeRoom } from '@/lib/session';
import type { Ended } from '@/lib/room';
import type { VoiceState } from '@/lib/voice';
import { POSITION_TICK_MS } from '@/lib/player';
import { loadUserOffset, saveUserOffset } from '@/lib/offset';
import { encodePasscode } from '@/lib/passcode';
import { loadVisuals, saveVisuals } from '@/lib/visuals';
import { keepAwake, onHidden } from '@/lib/wake';
import { Avatar } from '@/components/Avatar';
import { SpeakerBackdrop } from '@/components/SpeakerBackdrop';
import { Cover } from '@/components/Cover';
import { Roster } from '@/components/Roster';
import { Bar, Shell, TopBar, type Panel } from '@/components/Shell';
import { DebugOverlay } from '@/components/DebugOverlay';
import { MiniPlayer } from '@/components/MiniPlayer';
import { OffsetSlider } from '@/components/OffsetSlider';
import { Queue } from '@/components/Queue';
import { Reactions } from '@/components/Reactions';
import { ShareDialog } from '@/components/ShareDialog';
import { Stage } from '@/components/Stage';
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

  // Whether the ring of bars moves. Lazily, like the offset: no storage on the server.
  const [visuals, setVisuals] = useState(() => loadVisuals());
  const changeVisuals = useCallback((on: boolean) => {
    setVisuals(on);
    saveVisuals(on);
  }, []);

  // On a phone the stage scrolls away; the mini player takes over exactly then.
  const stage = useRef<HTMLElement>(null);
  const [stageVisible, setStageVisible] = useState(true);
  const mode = snapshot?.mode;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setStageVisible(entry!.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, [inRoom, mode]);

  // Files dropped anywhere on the music screen, for the creator.
  const [dragging, setDragging] = useState(false);

  // Which column a phone shows, and whether the audio-delay slider is open.
  const [panel, setPanel] = useState<Panel>('main');
  const [delayOpen, setDelayOpen] = useState(false);

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
  const hasCurrent = snapshot.currentTrackId !== undefined;
  const current = snapshot.mode === 'music' ? snapshot.playlist.find((t) => t.id === snapshot.currentTrackId) : undefined;

  const self = snapshot.peers.find((p) => p.peerId === snapshot.selfPeerId);
  const sharing = joinUrl && <ShareDialog url={joinUrl} hasPasscode={passcode !== undefined} />;
  const togglePeople = () => setPanel((p) => (p === 'aside' ? 'main' : 'aside'));

  const sidebar = (
    <>
      <Bar className="gap-2.5">
        <Cover title={snapshot.roomName} className="size-8 rounded-lg" />
        <span className="truncate">{snapshot.roomName}</span>
      </Bar>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        {!snapshot.ended && (
          <ModeSwitch
            mode={snapshot.mode}
            onChange={isCreator ? (mode) => room.setMode(mode) : undefined}
          />
        )}
        <Queue
          room={room}
          snapshot={snapshot}
          adding={adding}
          addError={addError}
          onFiles={(files) => void addTracks(files)}
        />
      </div>
      {snapshot.mode === 'talk' && !snapshot.ended && (
        <p className="mx-2 flex shrink-0 items-center gap-2 rounded-full bg-white/8 px-4 py-2 text-sm font-semibold text-chart-1">
          <span aria-hidden className="size-2 rounded-full bg-chart-1" />
          Talk connected
        </p>
      )}
      {delayOpen && (
        <div className="mx-2 mt-2 shrink-0 rounded-[20px] bg-white/8 p-3">
          <OffsetSlider valueMs={userOffsetMs} onChange={changeUserOffset} />
        </div>
      )}
      <div className="m-2 flex h-14 shrink-0 items-center gap-2.5 rounded-full bg-white/8 pr-2 pl-2">
        <Avatar name={self?.displayName ?? '?'} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-semibold">{self?.displayName}</span>
          <span className="text-xs text-muted-foreground">{isCreator ? 'host' : 'member'}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="My audio delay"
          aria-expanded={delayOpen}
          onClick={() => setDelayOpen((open) => !open)}
        >
          <Settings />
        </Button>
      </div>
    </>
  );

  const people = (
    <>
      <Bar>
        <Users className="size-5 text-muted-foreground" />
        In the room
      </Bar>
      <div className="px-2 pb-2">
        <Roster
          peers={snapshot.peers}
          selfPeerId={snapshot.selfPeerId}
          connections={snapshot.connections}
          transfers={snapshot.transfers}
          speaking={snapshot.mode === 'talk' ? snapshot.voice.speaking : undefined}
          selfMuted={snapshot.mode === 'talk' && snapshot.voice.micOn && snapshot.voice.muted}
          onKick={isCreator ? (peerId) => room.kick(peerId) : undefined}
        />
      </div>
    </>
  );

  const tabs = (
    <nav aria-label="Panels" className="glass mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] flex h-14 shrink-0 gap-1 rounded-full p-1 md:hidden">
      {(
        [
          { panel: 'main', label: 'Room', Icon: Music },
          { panel: 'sidebar', label: 'Playlist', Icon: ListMusic },
          { panel: 'aside', label: 'People', Icon: Users },
        ] as const
      ).map(({ panel: value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-current={panel === value ? 'page' : undefined}
          onClick={() => setPanel(value)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-semibold transition-[background-color,scale] duration-300 ease-soft active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            panel === value ? 'bg-white/16 text-foreground' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  );

  return (
    <Shell
      backdrop={
        <SpeakerBackdrop
          talk={snapshot.mode === 'talk'}
          speaker={[...snapshot.voice.speaking].map((id) => names.get(id)).find(Boolean)}
          fallback={current?.title ?? snapshot.roomName}
          art={current?.art}
          idle={!(snapshot.mode === 'music' && snapshot.playing)}
        />
      }
      sidebar={sidebar}
      aside={people}
      panel={panel}
      footer={
        <>
          {snapshot.mode === 'music' && !snapshot.ended && hasCurrent && !stageVisible && (
            <MiniPlayer room={room} snapshot={snapshot} positionSeconds={positionSeconds} />
          )}
          {tabs}
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
      <TopBar>
        {snapshot.mode === 'talk' ? (
          <Mic className="size-5 shrink-0 text-muted-foreground" />
        ) : (
          <Music className="size-5 shrink-0 text-muted-foreground" />
        )}
        <h1 className="truncate">{snapshot.roomName}</h1>
        {snapshot.description && (
          <p className="hidden min-w-0 truncate border-l border-white/20 pl-3 text-sm font-normal text-muted-foreground sm:block">
            {snapshot.description}
          </p>
        )}
        <span className="ml-auto flex items-center">
          {sharing}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex xl:hidden"
            aria-label="Show people"
            aria-pressed={panel === 'aside'}
            onClick={togglePeople}
          >
            <Users />
          </Button>
        </span>
      </TopBar>

      {snapshot.ended ? (
        // The roster behind this has no socket keeping it true, so it goes
        // rather than sitting there looking live next to the bad news.
        <div className={cn(CARD, 'mt-2 max-w-md animate-pop items-start')}>
          <DoorOpen className="size-8 text-destructive" />
          <p role="alert" className="text-lg font-semibold">
            {ENDED_MESSAGE[snapshot.ended]}
          </p>
          <Link href="/" className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft />
            Back to rooms
          </Link>
        </div>
      ) : snapshot.mode === 'talk' ? (
        <div className="flex flex-1 flex-col gap-4 pb-4">
          <TalkPanel voice={snapshot.voice} people={snapshot.peers.length} />
          <TalkGrid
            peers={snapshot.peers}
            selfPeerId={snapshot.selfPeerId}
            connections={snapshot.connections}
            speaking={snapshot.voice.speaking}
            selfMuted={snapshot.voice.micOn && snapshot.voice.muted}
            onKick={isCreator ? (peerId) => room.kick(peerId) : undefined}
          />
          <div className="glass sticky bottom-3 z-30 mx-auto mt-auto flex max-w-xl flex-wrap items-center justify-center gap-3 rounded-full p-2">
            {snapshot.voice.micOn ? (
              <Button
                type="button"
                size="lg"
                variant={snapshot.voice.muted ? 'outline' : 'default'}
                aria-pressed={snapshot.voice.muted}
                onClick={() => room.setMuted(!snapshot.voice.muted)}
              >
                {snapshot.voice.muted ? <MicOff /> : <Mic />}
                {snapshot.voice.muted ? 'Unmute' : 'Mute'}
              </Button>
            ) : (
              <Button type="button" size="lg" onClick={() => void room.enableMic()}>
                <Mic />
                Turn on microphone
              </Button>
            )}
            <Reactions room={room} names={names} className="flex gap-1" />
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'relative mb-4 flex min-w-0 flex-col gap-4 rounded-[28px] transition-shadow',
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
          <Stage
            room={room}
            snapshot={snapshot}
            positionSeconds={positionSeconds}
            visuals={visuals}
            onVisuals={changeVisuals}
            sectionRef={stage}
          />
        </div>
      )}

      {/* Everyone else's voice. Rendered whatever the mode shows, so a
          switch back to music cannot cut a sentence off mid-word. */}
      {[...snapshot.voice.streams].map(([peerId, stream]) => (
        <RemoteVoice key={peerId} stream={stream} />
      ))}
    </Shell>
  );
}

const CARD = 'panel flex flex-col gap-4 rounded-[20px] p-5 text-card-foreground sm:p-6';

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
      <p className="flex h-11 items-center gap-2 rounded-full bg-white/12 px-4 text-[0.9375rem] font-semibold text-foreground">
        <Icon className="size-5" />
        {label} mode
      </p>
    );
  }
  return (
    <div role="group" aria-label="Room mode" className="flex flex-col gap-0.5">
      {modes.map(({ mode: value, label, Icon }) => (
        <Button
          key={value}
          type="button"
          variant={mode === value ? 'secondary' : 'ghost'}
          className={cn('justify-start', mode === value && 'text-accent-foreground')}
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
        >
          <Icon />
          {label}
        </Button>
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
      <p className="flex items-start gap-2">
        <Headphones className="mt-0.5 size-5 shrink-0" />
        Everyone in this room can hear everyone else. Use headphones: speakers next to an open
        microphone feed back.
      </p>
      <p aria-live="polite" className="font-medium text-foreground">
        {voice.micOn ? (voice.muted ? 'You are muted.' : 'You are live.') : 'You can listen without a microphone.'}
      </p>
      {voice.error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {voice.error}
        </p>
      )}
      {people > COMFORTABLE_PEOPLE && (
        <p>
          Voice works best with {COMFORTABLE_PEOPLE} people or fewer. Larger rooms may stutter.
        </p>
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
