'use client';

/**
 * Starting the same audio on every device at the same instant.
 *
 * Everything before this exists to make the network irrelevant here: every
 * device already holds the decoded buffer, and every device already knows
 * how far its clock sits from the creator's. The only thing crossing the
 * wire at playback is a number saying when.
 *
 * That number is on the creator's `performance.now()` clock, and it travels
 * the DataChannel — the same wire the offset correcting it was measured on.
 * Sending it via the server would put the timing on a different path than
 * its own correction, and the server on the critical path of the one thing
 * this product does.
 *
 * Scheduling is `source.start(when)` against `AudioContext.currentTime`,
 * never setTimeout: a timer fires when the event loop gets to it, and that
 * variance is precisely what this design exists to eliminate.
 */

/**
 * How far ahead the creator schedules the start.
 *
 * Long enough that the cue reaches every peer and each one has its buffer
 * wired up before the instant arrives; short enough that the creator does
 * not feel the button lag. On a LAN the cue lands in single-digit ms.
 */
export const START_LEAD_MS = 500;

/** Creator -> peers. Play this buffer from `fromSeconds` at `startAt`. */
export interface PlayCue {
  type: 'play';
  /** The creator's monotonic clock. Meaningless here until offset-corrected. */
  startAt: number;
  /** Where in the track to start. Non-zero when resuming from a pause. */
  fromSeconds: number;
}

/** Creator -> peers. Stop at this instant, everyone on the same sample. */
export interface PauseCue {
  type: 'pause';
  /** The creator's monotonic clock. */
  pauseAt: number;
}

export type Cue = PlayCue | PauseCue;

/** Narrow a channel message to a cue. Shared wire: #5 and #6 are on it too. */
export function asCue(data: unknown): Cue | undefined {
  if (typeof data !== 'string') return undefined; // A file chunk. Not ours.
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const cue = value as Record<string, unknown>;
  if (cue.type === 'play') {
    return typeof cue.startAt === 'number' && typeof cue.fromSeconds === 'number'
      ? (cue as unknown as PlayCue)
      : undefined;
  }
  if (cue.type === 'pause') {
    return typeof cue.pauseAt === 'number' ? (cue as unknown as PauseCue) : undefined;
  }
  return undefined;
}

/**
 * The audio surface the player needs, and nothing more.
 *
 * A real AudioContext in a test means a real output device; this is the
 * seam that keeps the arithmetic testable. It is deliberately the shape
 * AudioContext already has, so the real one satisfies it as-is.
 */
export interface AudioSink {
  readonly currentTime: number;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioDestinationNode;
}

/** Reading the monotonic clock. Same seam as clock.ts, same reason. */
export type Now = () => number;

export interface PlayerState {
  playing: boolean;
  /**
   * Where the track is now, in seconds. Read for display; it is derived, not
   * stored, so it cannot drift from what is actually playing.
   */
  positionSeconds: number;
}

/**
 * One device's playback, driven by cues on the shared clock.
 *
 * The creator drives its own instance with the same cue it sends to
 * everyone, so there is no separate creator path to get subtly wrong: the
 * creator is simply the peer whose offset is zero.
 */
export class Player {
  readonly #sink: AudioSink;
  readonly #now: Now;
  readonly #buffer: AudioBuffer;
  readonly #listeners = new Set<() => void>();
  #source: AudioBufferSourceNode | undefined;
  /** Where the track was when it last stopped. Resumes pick up here. */
  #pausedAt = 0;
  /**
   * The audio-clock time the current source was scheduled to be at track
   * position zero. Position is derived from this, not counted.
   */
  #originAudioTime: number | undefined;
  #closed = false;

  constructor(input: { sink: AudioSink; buffer: AudioBuffer; now?: Now }) {
    this.#sink = input.sink;
    this.#buffer = input.buffer;
    this.#now = input.now ?? (() => performance.now());
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  state(): PlayerState {
    return { playing: this.#source !== undefined, positionSeconds: this.position() };
  }

  /**
   * Where the track is, in seconds.
   *
   * Derived from the audio clock rather than counted, so it cannot drift
   * from what the hardware is actually playing. Before a scheduled start
   * arrives this reads as the position it will start from, not a negative.
   */
  position(): number {
    if (this.#originAudioTime === undefined) return this.#pausedAt;
    const elapsed = this.#sink.currentTime - this.#originAudioTime;
    return Math.min(Math.max(elapsed, this.#pausedAt), this.#buffer.duration);
  }

  /**
   * Act on a cue, correcting the creator's clock to ours.
   *
   * `offsetMs` is what clock.ts measured: add it to our clock to get the
   * creator's, so subtract it to bring the creator's instant back to ours.
   * It is zero for the creator itself, which is why there is one path here
   * and not two.
   *
   * `userOffsetMs` is the listener's own nudge, for output the browser
   * cannot see the lag of — Bluetooth is 100-300ms late and says nothing.
   * Nothing passes it yet; #9 adds the slider that does.
   */
  apply(cue: Cue, offsetMs: number, userOffsetMs = 0): void {
    if (this.#closed) return;
    if (cue.type === 'pause') return this.#pause(cue.pauseAt - offsetMs + userOffsetMs);
    this.#play(cue.startAt - offsetMs + userOffsetMs, cue.fromSeconds);
  }

  close(): void {
    this.#closed = true;
    this.#stopSource();
    this.#listeners.clear();
  }

  /**
   * Schedule a start at a local monotonic instant.
   *
   * A cue whose instant has already passed still plays, from where the track
   * would be by now — a peer whose cue arrived late joins mid-track in sync
   * rather than starting from the beginning, alone.
   */
  #play(localStartMs: number, fromSeconds: number): void {
    this.#stopSource();
    const lateBySeconds = Math.max(0, (this.#now() - localStartMs) / 1000);
    const offsetIntoTrack = fromSeconds + lateBySeconds;
    if (offsetIntoTrack >= this.#buffer.duration) {
      // The track would already be over. Nothing to start.
      this.#pausedAt = this.#buffer.duration;
      this.#notify();
      return;
    }

    const source = this.#sink.createBufferSource();
    source.buffer = this.#buffer;
    source.connect(this.#sink.destination);

    // The audio clock and the monotonic clock are different clocks; this is
    // the one conversion between them, and it is why scheduling is sample
    // accurate rather than at the mercy of the event loop.
    const when = this.#sink.currentTime + Math.max(0, (localStartMs - this.#now()) / 1000);
    source.start(when, offsetIntoTrack);

    this.#source = source;
    this.#pausedAt = offsetIntoTrack;
    this.#originAudioTime = when - offsetIntoTrack;
    source.onended = () => {
      // Only if this is still the live source: stopping one to start another
      // fires onended too, and that is not the track finishing.
      if (this.#source !== source) return;
      this.#source = undefined;
      this.#originAudioTime = undefined;
      this.#pausedAt = this.#buffer.duration;
      this.#notify();
    };
    this.#notify();
  }

  /**
   * Stop at a local monotonic instant.
   *
   * Scheduled, not immediate: every device has to land on the same sample,
   * or resume starts them from positions that already disagree.
   */
  #pause(localPauseMs: number): void {
    const source = this.#source;
    if (!source || this.#originAudioTime === undefined) return;
    const when = this.#sink.currentTime + Math.max(0, (localPauseMs - this.#now()) / 1000);
    // Where the track will be at that instant — recorded now, because after
    // the stop the audio clock can no longer tell us.
    this.#pausedAt = Math.min(when - this.#originAudioTime, this.#buffer.duration);
    source.onended = null;
    source.stop(when);
    this.#source = undefined;
    this.#originAudioTime = undefined;
    this.#notify();
  }

  #stopSource(): void {
    const source = this.#source;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped, or never started. Either way it is not playing.
    }
    this.#source = undefined;
    this.#originAudioTime = undefined;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * The slice of the mesh the cues need: a channel per peer, and notice when
 * a new one opens. Same seam as Distributor, for the same reason — a real
 * RTCPeerConnection in a test is a test of WebRTC, not of this.
 */
export interface CueTransport {
  channel(peerId: string): RTCDataChannel | undefined;
  subscribe(listener: () => void): () => void;
}

/**
 * Send a cue to every peer whose channel is open.
 *
 * Best-effort by design: a peer whose channel is not open has either left or
 * is about to, and the room does not wait. Returns how many heard it, which
 * is what the creator's own scheduling does not depend on but a log does.
 */
export function broadcastCue(
  transport: Pick<CueTransport, 'channel'>,
  peerIds: readonly string[],
  cue: Cue,
): number {
  const payload = JSON.stringify(cue);
  let sent = 0;
  for (const peerId of peerIds) {
    const channel = transport.channel(peerId);
    if (channel?.readyState !== 'open') continue;
    try {
      channel.send(payload);
      sent++;
    } catch {
      // The channel died between the check and the send. Nothing to do: the
      // mesh will report it, and the room carries on without them.
    }
  }
  return sent;
}

/**
 * Listen for cues from the creator, reattaching when their channel opens.
 *
 * The channel does not exist yet when the room first renders — it arrives
 * with the mesh — so this subscribes and attaches on whichever notify brings
 * it, exactly as the clock probe does.
 */
export function listenForCues(
  transport: CueTransport,
  creatorPeerId: string,
  onCue: (cue: Cue) => void,
): () => void {
  let attached: RTCDataChannel | undefined;
  const handle = (event: MessageEvent) => {
    const cue = asCue(event.data);
    if (cue) onCue(cue);
  };
  const attach = () => {
    const channel = transport.channel(creatorPeerId);
    if (!channel || channel === attached) return;
    attached?.removeEventListener('message', handle);
    channel.addEventListener('message', handle);
    attached = channel;
  };
  attach();
  const unsubscribe = transport.subscribe(attach);
  return () => {
    unsubscribe();
    attached?.removeEventListener('message', handle);
  };
}
