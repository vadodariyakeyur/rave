'use client';

import type { Peer, RoomClosed, RoomState } from '@rave/protocol';
import { decodeBytes } from './audio';
import { ClockProbe, serveClock, type Clock, type Estimate } from './clock';
import { Distributor, Receiver, type Download } from './distribute';
import { Mesh, type PeerConnectionState } from './mesh';
import { Player, START_LEAD_MS, type AudioSink, type Every } from './player';
import type { Entered, Signaling } from './signaling';
import type { Outgoing, Transfer } from './transfer';
import type { Cue, PeerMessage, PlayCue, Track } from './wire';

/**
 * Why the room is over for this device. 'lost-connection' is our own socket
 * dropping, which is not the same event as the room closing — telling
 * someone the host left when their wifi died is a lie they will act on.
 */
export type Ended = RoomClosed['reason'] | 'lost-connection';

/** A playlist entry, with where it stands on this device. */
export interface PlaylistItem extends Track, Download {}

/** Everything the screen shows, as of one moment. Replaced, never mutated. */
export interface RoomSnapshot {
  code: string;
  roomName: string;
  description: string;
  /** The server's own truth about who is in the room. */
  peers: Peer[];
  selfPeerId: string;
  isCreator: boolean;
  /**
   * The passcode this device got in with, if the room has one. Kept so the
   * share link and QR can carry it; the server never sends it back.
   */
  passcode?: string;
  ended?: Ended;
  connections: ReadonlyMap<string, PeerConnectionState>;
  /** Creator only: how much of the playlist each member has been sent. */
  transfers: ReadonlyMap<string, Transfer>;
  /** In the creator's order. Empty until the creator adds something. */
  playlist: PlaylistItem[];
  /** The track the room is on, playing or not. */
  currentTrackId?: string;
  /** Seconds, once the current track has been decoded here. */
  currentDuration?: number;
  playing: boolean;
  /** Undefined on the creator: it is the clock, so it has no offset to itself. */
  estimate?: Estimate;
}

type RoomSignaling = Pick<Signaling, 'send' | 'onMessage' | 'onClose' | 'close'>;
type RoomAudio = AudioSink & Pick<AudioContext, 'decodeAudioData' | 'close'>;
type RoomMesh = Pick<Mesh, 'states' | 'link' | 'subscribe' | 'sync' | 'close'>;

/** What a test swaps out. The browser's own, by default. */
export interface RoomDeps {
  createMesh: (input: ConstructorParameters<typeof Mesh>[0]) => RoomMesh;
  clock: Clock;
  every?: Every;
  /** Mints a track id. */
  id: () => string;
}

const realDeps: RoomDeps = {
  createMesh: (input) => new Mesh(input),
  clock: {
    now: () => performance.now(),
    sleep: (ms, resolve) => {
      const timer = setTimeout(resolve, ms);
      return () => clearTimeout(timer);
    },
  },
  id: () => crypto.randomUUID(),
};

/**
 * One device's place in a room, from the moment it is entered until it ends.
 *
 * Everything that has to happen in a particular order lives here: the mesh
 * follows the roster, the playlist follows the mesh, the clock is measured
 * over the same link the cues arrive on, and playback takes each track and
 * the offset whenever each turns up. The screen reads {@link snapshot} and
 * calls the few things a person can do; it decides none of the ordering, so
 * a re-render or a remount cannot change what the room does.
 *
 * A room starts with no tracks and nobody is ever locked out of it: someone
 * arriving mid-track is sent the playlist and the cue in force, and starts
 * from wherever the room has got to.
 *
 * Held outside React for the same reason as ever: the socket and the armed
 * AudioContext cannot be recreated after the tap that made them.
 */
export class LiveRoom {
  readonly #signaling: RoomSignaling;
  readonly #audio: RoomAudio;
  readonly #clock: Clock;
  readonly #id: () => string;
  readonly #mesh: RoomMesh;
  readonly #player: Player;
  readonly #selfPeerId: string;
  readonly #isCreator: boolean;
  readonly #passcode: string | undefined;
  readonly #listeners = new Set<() => void>();
  /** Everything to undo when the room ends, whichever way it ends. */
  readonly #teardown: (() => void)[] = [];
  /** Creator only: the members being answered, and how to stop. */
  readonly #served = new Map<string, () => void>();
  /** Creator only: every track's encoded bytes, which is what gets sent. */
  readonly #files = new Map<string, Outgoing>();
  #distributor: Distributor | undefined;
  #receiver: Receiver | undefined;
  #state: RoomState;
  #ended: Ended | undefined;
  #playlist: Track[] = [];
  #currentTrackId: string | undefined;
  /** The track decoded for the player, and how long it is. One at a time. */
  #decoded: { trackId: string; duration: number } | undefined;
  /** The track being decoded right now, so it is not decoded twice over. */
  #preparing: string | undefined;
  /** Creator only: the cue in force, for whoever arrives next. */
  #lastCue: Cue | undefined;
  /** Creator only: what the room list was last told. */
  #nowPlaying: string | null = null;
  #estimate: Estimate | undefined;
  #snapshot: RoomSnapshot;
  #closed = false;

  constructor(
    input: {
      signaling: RoomSignaling;
      audioContext: RoomAudio;
      entered: Entered;
      passcode?: string;
    },
    deps: Partial<RoomDeps> = {},
  ) {
    const { createMesh, clock, every, id } = { ...realDeps, ...deps };
    const { signaling, entered } = input;
    this.#signaling = signaling;
    this.#audio = input.audioContext;
    this.#clock = clock;
    this.#id = id;
    this.#passcode = input.passcode;
    this.#state = entered.state;
    this.#selfPeerId = entered.peerId;
    const creatorId = entered.state.peers.find((p) => p.isCreator)?.peerId;
    this.#isCreator = creatorId === entered.peerId;

    // One player per device, driven by cues on the creator's clock —
    // including on the creator itself. Two paths here would be two chances
    // to schedule differently.
    this.#player = new Player({ sink: input.audioContext, now: clock.now, every });
    this.#teardown.push(this.#player.subscribe(() => this.#played()));

    this.#mesh = createMesh({
      signaling: signaling as Signaling,
      selfPeerId: entered.peerId,
      iceServers: entered.iceServers,
    });
    this.#teardown.push(this.#mesh.subscribe(() => this.#emit()));

    if (this.#isCreator) {
      // The creator is the reference: the instant it cues is already in the
      // clock every member measured itself against.
      this.#player.setClockOffset(0);
      const distributor = new Distributor(this.#mesh);
      this.#teardown.push(distributor.subscribe(() => this.#emit()), () => distributor.close());
      this.#distributor = distributor;
    } else if (creatorId !== undefined) {
      this.#follow(creatorId);
    }

    this.#teardown.push(
      signaling.onMessage((msg) => {
        if (msg.type === 'room-state') this.#roster(msg);
        if (msg.type === 'room-closed') this.#end(msg.reason);
      }),
      // A dropped socket leaves the roster frozen and looking live — but it
      // is our socket, not the room.
      signaling.onClose(() => this.#end('lost-connection')),
    );

    this.#snapshot = this.#build();
    this.#roster(entered.state);
  }

  snapshot(): RoomSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Creator only: add files to the end of the playlist.
   *
   * Each is decoded once here, and the result thrown away, purely to find
   * out whether it can be: a file that will not decode must never reach a
   * member, who would have no way to know why their device is silent.
   * Rejects with the first such file's error; the good ones are still added.
   */
  async addTracks(files: readonly File[]): Promise<void> {
    if (!this.#isCreator || this.#ended) return;
    let failure: unknown;
    for (const file of files) {
      try {
        const bytes = await file.arrayBuffer();
        await decodeBytes(this.#audio, bytes);
        if (this.#ended || this.#closed) return;
        const trackId = this.#id();
        this.#files.set(trackId, { trackId, bytes, fileName: file.name });
        this.#setPlaylist([
          ...this.#playlist,
          { id: trackId, title: file.name, byteLength: bytes.byteLength },
        ]);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  /** Creator only. Removing the track the room is on stops it first. */
  removeTrack(trackId: string): void {
    if (!this.#isCreator || this.#ended) return;
    if (trackId === this.#currentTrackId) {
      this.stop();
      this.#currentTrackId = undefined;
    }
    this.#files.delete(trackId);
    this.#setPlaylist(this.#playlist.filter((t) => t.id !== trackId));
  }

  /** Creator only: move a track one place up (-1) or down (+1). */
  moveTrack(trackId: string, by: -1 | 1): void {
    if (!this.#isCreator || this.#ended) return;
    const from = this.#playlist.findIndex((t) => t.id === trackId);
    const to = from + by;
    if (from < 0 || to < 0 || to >= this.#playlist.length) return;
    const next = [...this.#playlist];
    [next[from], next[to]] = [next[to]!, next[from]!];
    this.#setPlaylist(next);
  }

  /**
   * Creator only: play a track from the top, on every device at once.
   *
   * Everyone is told which track first, so they decode it while we do. The
   * cue goes out once ours is ready; a device that takes longer joins a
   * moment into the track, in sync, rather than holding the room up.
   */
  async playTrack(trackId: string): Promise<void> {
    if (!this.#isCreator || this.#ended || !this.#files.has(trackId)) return;
    this.#select(trackId);
    this.#broadcast({ type: 'select', trackId });
    await this.#prepare(trackId);
    // The creator picked something else, or stopped, while this decoded.
    if (this.#currentTrackId !== trackId || this.#decoded?.trackId !== trackId) return;
    this.#cue((at) => ({ type: 'play', trackId, startAt: at, fromSeconds: 0 }));
  }

  /** Creator only: the current track again, from the top. */
  restart(): void {
    if (this.#currentTrackId) void this.playTrack(this.#currentTrackId);
  }

  /** Creator only: everyone carries on from where the track stopped. */
  resume(): void {
    const trackId = this.#currentTrackId;
    if (!trackId || this.#decoded?.trackId !== trackId) return;
    this.#cue((at) => ({ type: 'play', trackId, startAt: at, fromSeconds: this.#player.position() }));
  }

  /** Creator only: everyone stops on the same sample. */
  pause(): void {
    this.#cue((at) => ({ type: 'pause', pauseAt: at }));
  }

  /** Creator only: everyone stops, and the track goes back to the start. */
  stop(): void {
    this.#cue(() => ({ type: 'stop' }));
  }

  /** Creator only: remove a member. They may join again. */
  kick(peerId: string): void {
    if (!this.#isCreator || this.#ended) return;
    this.#signaling.send({ type: 'kick', peerId });
  }

  /** The listener's own latency correction, heard as it changes. */
  setUserOffset(userOffsetMs: number): void {
    this.#player.setUserOffset(userOffsetMs);
  }

  /**
   * Where the track is, in seconds. Derived from the audio clock rather
   * than pushed, so nothing notifies when it moves: read it on a tick.
   */
  position(): number {
    return this.#player.position();
  }

  /** How far this device has slipped from the shared clock, in ms. */
  drift(): number {
    return this.#player.drift();
  }

  /** Leave: hang up on the server and let go of the audio. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    this.#listeners.clear();
    this.#signaling.close();
    void this.#audio.close().catch(() => {});
  }

  /**
   * The member's side: the playlist, the files, the clock and the cues all
   * come from the creator, over the one link.
   */
  #follow(creatorId: string): void {
    const creator = this.#mesh.link(creatorId);

    const receiver = new Receiver(creator);
    this.#receiver = receiver;
    this.#teardown.push(
      receiver.subscribe(() => {
        // A track removed while it was on its way here is not kept.
        receiver.keep(this.#playlist.map((t) => t.id));
        // The track the room is on may be the one that just landed.
        if (this.#currentTrackId) void this.#prepare(this.#currentTrackId);
        this.#emit();
      }),
      () => receiver.close(),
    );
    receiver.start();

    const probe = new ClockProbe(creator, this.#clock);
    this.#teardown.push(
      probe.subscribe(() => {
        this.#estimate = probe.estimate();
        // A lost round keeps the last offset, and so does the player.
        if (this.#estimate.offsetMs !== undefined) this.#player.setClockOffset(this.#estimate.offsetMs);
        this.#emit();
      }),
      () => probe.close(),
    );
    probe.start();

    const hear = (cue: Cue) => {
      if (cue.type === 'play') {
        this.#select(cue.trackId);
        void this.#prepare(cue.trackId);
      }
      // Straight to the player, track or no track: it holds a cue until it
      // can act on it, and the one that arrives early is the one that
      // starts the music.
      this.#player.cue(cue);
      this.#emit();
    };
    this.#teardown.push(
      creator.on('playlist', (msg) => {
        this.#playlist = msg.tracks;
        receiver.keep(msg.tracks.map((t) => t.id));
        this.#emit();
      }),
      creator.on('select', (msg) => {
        this.#select(msg.trackId);
        void this.#prepare(msg.trackId);
        this.#emit();
      }),
      creator.on('play', hear),
      creator.on('pause', hear),
      creator.on('stop', hear),
    );
  }

  /**
   * A roster arrived. Reconciled every time, including the first: a missed
   * event cannot then leave a phantom peer connected.
   */
  #roster(state: RoomState): void {
    if (this.#ended) return;
    this.#state = state;
    // A member connects to the creator and nobody else: everything it needs
    // comes from there, and a link per pair of members would grow with the
    // square of the room for nothing.
    this.#mesh.sync(
      this.#isCreator
        ? state.peers
        : state.peers.filter((p) => p.isCreator || p.peerId === this.#selfPeerId),
    );

    if (this.#isCreator) {
      const others = this.#others();
      // Idempotent per member, so a roster change never restarts a transfer
      // in flight.
      this.#distributor?.sync(others);
      for (const [peerId, stop] of this.#served) {
        if (others.includes(peerId)) continue;
        stop();
        this.#served.delete(peerId);
      }
      for (const peerId of others) {
        if (this.#served.has(peerId)) continue;
        const link = this.#mesh.link(peerId);
        this.#served.set(peerId, serveClock(link, this.#clock.now));
        // Whoever arrives, whenever: where the room is, as soon as they
        // can hear it. Gone before their link opened is not an error.
        void link.opened().then(
          () => this.#greet(peerId),
          () => {},
        );
      }
    }
    this.#emit();
  }

  /** Tell one new arrival where the room is. */
  #greet(peerId: string): void {
    if (this.#ended || !this.#served.has(peerId)) return;
    const link = this.#mesh.link(peerId);
    link.send({ type: 'playlist', tracks: this.#playlist });
    if (this.#currentTrackId) link.send({ type: 'select', trackId: this.#currentTrackId });
    // The cue itself, not a fresh one: its instant is in the past by now,
    // which is exactly what makes the newcomer start mid-track in sync.
    if (this.#lastCue) link.send(this.#lastCue);
  }

  /** Creator only: the playlist changed. Everyone hears the whole of it. */
  #setPlaylist(playlist: Track[]): void {
    this.#playlist = playlist;
    this.#distributor?.setTracks(playlist.map((t) => this.#files.get(t.id)!));
    this.#broadcast({ type: 'playlist', tracks: playlist });
    this.#emit();
  }

  /** The room is on this track now. */
  #select(trackId: string): void {
    if (this.#currentTrackId === trackId) return;
    this.#currentTrackId = trackId;
    // The last track's cue says nothing about this one.
    this.#lastCue = undefined;
  }

  /**
   * Decode a track for the player, if its bytes are here and it is not
   * already the one decoded. Safe to call again and again: a member calls
   * it on every download until the track it is waiting for has landed.
   */
  async #prepare(trackId: string): Promise<void> {
    if (this.#decoded?.trackId === trackId || this.#preparing === trackId) return;
    const bytes = this.#files.get(trackId)?.bytes ?? this.#receiver?.bytes(trackId);
    if (!bytes) return;
    this.#preparing = trackId;
    try {
      const { buffer } = await decodeBytes(this.#audio, bytes);
      // The room moved on, or ended, while this decoded.
      if (this.#ended || this.#closed || this.#currentTrackId !== trackId) return;
      this.#decoded = { trackId, duration: buffer.duration };
      this.#player.load(trackId, buffer);
      this.#emit();
    } catch {
      // The creator decoded this very file, so this is rare: a format this
      // browser lacks. This device sits the track out.
    } finally {
      if (this.#preparing === trackId) this.#preparing = undefined;
      // Asked for another while this one was decoding.
      if (this.#currentTrackId && this.#currentTrackId !== trackId) {
        void this.#prepare(this.#currentTrackId);
      }
    }
  }

  /**
   * Cue every member, and ourselves, off one instant on our own clock.
   *
   * One path for play, pause, resume and stop: a second spelling is a
   * second way to drift. No conversion here — all of it happens on the
   * receiving side.
   */
  #cue(make: (at: number) => Cue): void {
    if (!this.#isCreator || this.#ended) return;
    const cue = make(this.#clock.now() + START_LEAD_MS);
    this.#lastCue = cue;
    this.#broadcast(cue);
    this.#player.cue(cue);
    this.#emit();
  }

  /**
   * Best-effort: a member whose link is not open has either left or is
   * still arriving, and the room does not wait. An arrival is greeted with
   * the same state once their link opens.
   */
  #broadcast(msg: PeerMessage): void {
    for (const peerId of this.#others()) this.#mesh.link(peerId).send(msg);
  }

  /** Playback started or stopped on this device. */
  #played(): void {
    if (this.#isCreator && !this.#ended) {
      const { playing } = this.#player.state();
      // A track that ran out is over for everyone: a member arriving now
      // must not be handed the cue that started it.
      if (!playing && this.#lastCue?.type === 'play') this.#lastCue = undefined;
      // The server sees no playback, so the room list knows only this.
      const title = playing
        ? (this.#playlist.find((t) => t.id === this.#currentTrackId)?.title ?? null)
        : null;
      if (title !== this.#nowPlaying) {
        this.#nowPlaying = title;
        this.#signaling.send({ type: 'now-playing', title });
      }
    }
    this.#emit();
  }

  #others(): string[] {
    return this.#state.peers.map((p) => p.peerId).filter((id) => id !== this.#selfPeerId);
  }

  /**
   * The room is over for this device. The first reason stands: the server
   * hangs up right after telling a kicked member why, and that hang-up must
   * not rewrite "you were removed" into "lost the connection".
   */
  #end(reason: Ended): void {
    if (this.#ended || this.#closed) return;
    this.#ended = reason;
    this.#stop();
    this.#emit();
  }

  /** Stop everything: no peers to hold open, and no audio left to play. */
  #stop(): void {
    for (const undo of this.#teardown.splice(0)) undo();
    for (const stop of this.#served.values()) stop();
    this.#served.clear();
    this.#files.clear();
    this.#mesh.close();
    this.#player.close();
  }

  #emit(): void {
    if (this.#closed) return;
    this.#snapshot = this.#build();
    for (const listener of [...this.#listeners]) listener();
  }

  #build(): RoomSnapshot {
    return {
      code: this.#state.code,
      roomName: this.#state.roomName,
      description: this.#state.description,
      peers: this.#state.peers,
      selfPeerId: this.#selfPeerId,
      isCreator: this.#isCreator,
      passcode: this.#passcode,
      ended: this.#ended,
      // Copies: the mesh mutates its own in place, and a reader comparing
      // snapshots must see a change.
      connections: new Map(this.#mesh.states()),
      transfers: this.#distributor?.transfers() ?? new Map(),
      playlist: this.#playlist.map((track) => ({
        ...track,
        // The creator holds every track from the moment it is added.
        ...(this.#receiver?.download(track.id) ?? { progress: 1, state: 'ready' as const }),
      })),
      currentTrackId: this.#currentTrackId,
      currentDuration:
        this.#decoded?.trackId === this.#currentTrackId ? this.#decoded?.duration : undefined,
      playing: this.#player.state().playing,
      estimate: this.#estimate,
    };
  }
}
