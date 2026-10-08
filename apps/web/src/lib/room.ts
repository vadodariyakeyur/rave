'use client';

import type { Peer, RoomClosed, RoomState } from '@rave/protocol';
import { ClockProbe, serveClock, type Clock, type Estimate } from './clock';
import { Distributor, Receiver } from './distribute';
import { Mesh, type PeerConnectionState } from './mesh';
import { Player, START_LEAD_MS, type AudioSink, type Every } from './player';
import type { Entered, Signaling } from './signaling';
import type { Transfer } from './transfer';
import type { Cue } from './wire';

/**
 * Why the room is over for this device. 'lost-connection' is our own socket
 * dropping, which is not the same event as the room closing — telling
 * someone the host left when their wifi died is a lie they will act on.
 */
export type Ended = RoomClosed['reason'] | 'lost-connection';

/** Everything the screen shows, as of one moment. Replaced, never mutated. */
export interface RoomSnapshot {
  code: string;
  roomName: string;
  /** The server's own truth about who is in the room. */
  peers: Peer[];
  locked: boolean;
  selfPeerId: string;
  isCreator: boolean;
  ended?: Ended;
  connections: ReadonlyMap<string, PeerConnectionState>;
  /**
   * Who holds the file, and how far along. The creator watches every peer's
   * download; a joiner watches only its own. One map because the roster
   * renders one list either way.
   */
  transfers: ReadonlyMap<string, Transfer>;
  /** Absent for a joiner until the transfer has landed and decoded. */
  track?: { fileName: string; durationSeconds: number };
  playing: boolean;
  /** Undefined on the creator: it is the clock, so it has no offset to itself. */
  estimate?: Estimate;
}

/** The creator's file: decoded to play here, still encoded to send. */
export interface RoomFile {
  buffer: AudioBuffer;
  bytes: ArrayBuffer;
  fileName: string;
}

type RoomSignaling = Pick<Signaling, 'send' | 'onMessage' | 'onClose' | 'close'>;
type RoomAudio = AudioSink & Pick<AudioContext, 'decodeAudioData' | 'close'>;
type RoomMesh = Pick<Mesh, 'states' | 'link' | 'subscribe' | 'sync' | 'close'>;

/** What a test swaps out. The browser's own, by default. */
export interface RoomDeps {
  createMesh: (input: ConstructorParameters<typeof Mesh>[0]) => RoomMesh;
  clock: Clock;
  every?: Every;
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
};

/**
 * One device's place in a room, from the moment it is entered until it ends.
 *
 * Everything that has to happen in a particular order lives here: the mesh
 * follows the roster, the file follows the mesh, the clock is measured over
 * the same link the cues arrive on, and playback takes the track and the
 * offset whenever each turns up. The screen reads {@link snapshot} and calls
 * the few things a person can do; it decides none of the ordering, so a
 * re-render or a remount cannot change what the room does.
 *
 * Held outside React for the same reason: the socket, the armed AudioContext
 * and the decoded buffer cannot be recreated after the tap that made them.
 */
export class LiveRoom {
  readonly #signaling: RoomSignaling;
  readonly #audio: RoomAudio;
  readonly #clock: Clock;
  readonly #mesh: RoomMesh;
  readonly #player: Player;
  readonly #selfPeerId: string;
  readonly #isCreator: boolean;
  readonly #listeners = new Set<() => void>();
  /** Everything to undo when the room ends, whichever way it ends. */
  readonly #teardown: (() => void)[] = [];
  /** Creator only: the peers whose clock pings are being answered. */
  readonly #served = new Map<string, () => void>();
  #distributor: Distributor | undefined;
  #state: RoomState;
  #ended: Ended | undefined;
  #track: RoomSnapshot['track'];
  #ownTransfer: Transfer | undefined;
  #estimate: Estimate | undefined;
  #snapshot: RoomSnapshot;
  #closed = false;

  constructor(
    input: { signaling: RoomSignaling; audioContext: RoomAudio; entered: Entered; file?: RoomFile },
    deps: Partial<RoomDeps> = {},
  ) {
    const { createMesh, clock, every } = { ...realDeps, ...deps };
    const { signaling, entered, file } = input;
    this.#signaling = signaling;
    this.#audio = input.audioContext;
    this.#clock = clock;
    this.#state = entered.state;
    this.#selfPeerId = entered.peerId;
    const creatorId = entered.state.peers.find((p) => p.isCreator)?.peerId;
    this.#isCreator = creatorId === entered.peerId;

    // One player per device, driven by cues on the creator's clock —
    // including on the creator itself. Two paths here would be two chances
    // to schedule differently.
    this.#player = new Player({ sink: input.audioContext, buffer: file?.buffer, now: clock.now, every });
    this.#teardown.push(this.#player.subscribe(() => this.#emit()));

    this.#mesh = createMesh({
      signaling: signaling as Signaling,
      selfPeerId: entered.peerId,
      iceServers: entered.iceServers,
    });
    this.#teardown.push(this.#mesh.subscribe(() => this.#emit()));

    if (this.#isCreator && file) {
      // The creator is the reference: the instant it cues is already in the
      // clock every peer measured itself against.
      this.#player.setClockOffset(0);
      this.#track = { fileName: file.fileName, durationSeconds: file.buffer.duration };
      const distributor = new Distributor(this.#mesh, { bytes: file.bytes, fileName: file.fileName });
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
   * Ask the server to lock the room and start. `force` leaves behind
   * whoever is not ready.
   *
   * Nothing plays yet: the first cue fires when the server confirms the
   * lock, because the lock is what settles who is actually in the room, and
   * a cue sent a moment earlier would name peers about to be excluded.
   */
  start(force: boolean): void {
    if (this.#ended) return;
    this.#signaling.send({ type: 'start-playback', force });
  }

  /** Creator only: everyone resumes from where the track stopped. */
  play(): void {
    // Zero on a first play; where we paused on a resume.
    this.#cue((at) => ({ type: 'play', startAt: at, fromSeconds: this.#player.position() }));
  }

  /** Creator only: everyone stops on the same sample. */
  pause(): void {
    this.#cue((at) => ({ type: 'pause', pauseAt: at }));
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
   * The joiner's side: the file, the clock and the cues all come from the
   * creator, over the one link.
   */
  #follow(creatorId: string): void {
    const creator = this.#mesh.link(creatorId);

    const receiver = new Receiver(creator, { audioContext: this.#audio, signaling: this.#signaling });
    this.#teardown.push(
      receiver.subscribe(() => {
        this.#ownTransfer = receiver.transfer();
        const result = receiver.result();
        if (result && !this.#track) {
          this.#track = { fileName: result.fileName, durationSeconds: result.buffer.duration };
          // Before the receiver says ready, so the cue that readiness
          // invites cannot arrive ahead of the track it starts.
          this.#player.load(result.buffer);
        }
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

    // From the first moment, not once there is a track: the cue that arrives
    // in between is the one that starts it, and the player holds it.
    this.#teardown.push(
      creator.on('play', (cue) => this.#player.cue(cue)),
      creator.on('pause', (cue) => this.#player.cue(cue)),
    );
  }

  /**
   * A roster arrived. Reconciled every time, including the first: a missed
   * event cannot then leave a phantom peer connected.
   */
  #roster(state: RoomState): void {
    if (this.#ended) return;
    const wasLocked = this.#state.locked;
    this.#state = state;
    this.#mesh.sync(state.peers);

    if (this.#isCreator) {
      const others = this.#others();
      // Idempotent per peer, so a roster change never restarts a transfer
      // in flight.
      this.#distributor?.sync(others);
      for (const [peerId, stop] of this.#served) {
        if (others.includes(peerId)) continue;
        stop();
        this.#served.delete(peerId);
      }
      for (const peerId of others) {
        if (this.#served.has(peerId)) continue;
        this.#served.set(peerId, serveClock(this.#mesh.link(peerId), this.#clock.now));
      }
      // Once, on the lock itself. The roster changes after it too — an
      // excluded peer leaving is a roster change — and recueing then would
      // restart the track from the top for everyone still listening.
      if (state.locked && !wasLocked) {
        this.#cue((at) => ({ type: 'play', startAt: at, fromSeconds: 0 }));
      }
    }
    this.#emit();
  }

  /**
   * Cue every peer, and ourselves, off one instant on our own clock.
   *
   * One path for the first play and for every pause and resume after it: a
   * second spelling is a second way to drift. No conversion here — all of
   * it happens on the receiving side.
   */
  #cue(make: (at: number) => Cue): void {
    if (!this.#isCreator || this.#ended || !this.#state.locked) return;
    const cue = make(this.#clock.now() + START_LEAD_MS);
    // Best-effort: a peer whose link is not open has either left or is
    // about to, and the room does not wait.
    for (const peerId of this.#others()) this.#mesh.link(peerId).send(cue);
    this.#player.cue(cue);
  }

  #others(): string[] {
    return this.#state.peers.map((p) => p.peerId).filter((id) => id !== this.#selfPeerId);
  }

  /**
   * The room is over for this device. The first reason stands: the server
   * hangs up right after telling an excluded peer why, and that hang-up
   * must not rewrite "started without you" into "lost the connection".
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
      peers: this.#state.peers,
      locked: this.#state.locked,
      selfPeerId: this.#selfPeerId,
      isCreator: this.#isCreator,
      ended: this.#ended,
      // Copies: the mesh and the distributor mutate their own in place, and
      // a reader comparing snapshots must see a change.
      connections: new Map(this.#mesh.states()),
      transfers: this.#distributor
        ? new Map(this.#distributor.transfers())
        : new Map(this.#ownTransfer ? [[this.#selfPeerId, this.#ownTransfer]] : []),
      track: this.#track,
      playing: this.#player.state().playing,
      estimate: this.#estimate,
    };
  }
}
