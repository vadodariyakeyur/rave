'use client';

import type { Cue, PlayCue } from './wire';

/**
 * Starting the same audio on every device at the same instant.
 *
 * Everything before this exists to make the network irrelevant here: every
 * device already holds the decoded buffer, and every device already knows
 * how far its clock sits from the creator's. The only thing crossing the
 * wire at playback is a number saying when.
 *
 * That number is on the creator's `performance.now()` clock, and it travels
 * the peer link — the same wire the offset correcting it was measured on.
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

/**
 * How often each peer checks itself against the shared clock.
 *
 * Audio clocks diverge by a few parts per million, so drift accumulates over
 * minutes, not seconds. Checking faster measures jitter instead of drift and
 * corrects against noise.
 */
export const DRIFT_CHECK_MS = 10_000;

/**
 * How often the progress bar re-reads the position.
 *
 * Fast enough that the bar moves smoothly and the seconds tick over on
 * time, slow enough to stay off the drift-correction cadence: position is
 * derived from the audio clock, so reading it more often than the eye can
 * resolve just re-renders the room for nothing.
 */
export const POSITION_TICK_MS = 250;

/**
 * Drift small enough to ignore.
 *
 * Every correction is a pitch change, so the floor has to sit above the
 * measurement noise — otherwise the track is permanently being nudged
 * towards a number that was never wrong.
 */
export const DRIFT_FLOOR_MS = 5;

/**
 * Drift too large to nudge away.
 *
 * Above this, closing the gap at an inaudible rate would take minutes and
 * sound wrong for all of them. A reseek is one audible glitch instead.
 */
export const DRIFT_RESEEK_MS = 100;

/**
 * How hard the nudge pulls.
 *
 * 0.2% is well under the ~1% where pitch change becomes audible, and closes
 * a 50ms gap in about 25 seconds — slow enough to be inaudible, fast enough
 * to matter before the next check.
 */
export const NUDGE_RATE = 0.002;

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

/** Calling back on a cadence. Returns a canceller. setInterval, as a seam. */
export type Every = (ms: number, fn: () => void) => () => void;

const realEvery: Every = (ms, fn) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

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
 * It exists from the moment audio is armed, before there is a track to play
 * or an offset to play it by, and takes each when it arrives — a new track
 * every time the room moves to one. A cue heard
 * before both are in hand is held, not dropped: the creator's cue is one
 * fire-and-forget send with no replay, and dropping it is silence for the
 * rest of the track. So the caller's whole job is to pass things on as they
 * happen — in any order.
 *
 * The creator drives its own instance with the same cue it sends to
 * everyone, so there is no separate creator path to get subtly wrong: the
 * creator is simply the peer whose offset is zero.
 */
export class Player {
  readonly #sink: AudioSink;
  readonly #now: Now;
  readonly #every: Every;
  readonly #listeners = new Set<() => void>();
  /**
   * The one decoded track, and which it is. Absent until something has been
   * selected and decoded; replaced whenever another track is.
   */
  #track: { id: string; buffer: AudioBuffer } | undefined;
  #source: AudioBufferSourceNode | undefined;
  /** Where the track was when it last stopped. Resumes pick up here. */
  #pausedAt = 0;
  /**
   * The audio-clock time the current source was scheduled to be at track
   * position zero. Position is derived from this, not counted.
   */
  #originAudioTime: number | undefined;
  /**
   * The play cue in force, still on the creator's clock.
   *
   * Kept because drift needs an expectation to compare against, and this is
   * it — where the shared clock says we should be. Kept uncorrected because
   * the correction is not a constant: the offset is re-measured for as long
   * as the room is open, and a track that only ever saw the value from the
   * moment it started is wrong by the end of a long one.
   */
  #playing: PlayCue | undefined;
  /** The last cue heard that could not be acted on yet. */
  #held: Cue | undefined;
  /**
   * What clock.ts measured: add it to our clock to get the creator's.
   * Undefined until a first round lands — and until then a cue cannot be
   * placed at all, since the two clocks share no origin.
   */
  #clockOffsetMs: number | undefined;
  /** The listener's own nudge, in ms. Negative plays earlier. */
  #userOffsetMs = 0;
  /** Cancels the drift check, which runs only while there is a source. */
  #stopCorrecting: (() => void) | undefined;
  #closed = false;

  constructor(input: {
    sink: AudioSink;
    track?: { id: string; buffer: AudioBuffer };
    now?: Now;
    every?: Every;
  }) {
    this.#sink = input.sink;
    this.#track = input.track;
    this.#now = input.now ?? (() => performance.now());
    this.#every = input.every ?? realEvery;
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
    return Math.min(Math.max(elapsed, this.#pausedAt), this.#track?.buffer.duration ?? 0);
  }

  /**
   * A track has been decoded, replacing whichever was here. A cue that was
   * waiting on it plays now.
   */
  load(id: string, buffer: AudioBuffer): void {
    if (this.#closed || this.#track?.id === id) return;
    // Whatever was playing was the old track. Its position means nothing
    // in this one.
    this.#halt();
    this.#track = { id, buffer };
    this.#release();
  }

  /**
   * Act on a cue from the creator — now, or as soon as it can be.
   *
   * `#play` already starts a cue whose instant has passed from where the
   * track would be by now, so a cue that had to wait joins mid-track in sync
   * rather than from the top, alone.
   */
  cue(cue: Cue): void {
    if (this.#closed) return;
    // The room has moved to another track. Go quiet now rather than play
    // the old one on until the new one has decoded.
    if (cue.type === 'play' && this.#track && cue.trackId !== this.#track.id) this.#halt();
    // Only the latest matters: a play superseded by a pause before either
    // could be acted on is a track that should not be playing.
    this.#held = cue;
    this.#release();
  }

  /**
   * The measured offset to the creator's clock, each time it is measured.
   *
   * Zero for the creator itself, which is why there is one path here and
   * not two. A new value does not jump a playing track: it moves where
   * {@link drift} says the track should be, and the next correction closes
   * the gap the usual way.
   */
  setClockOffset(offsetMs: number): void {
    if (this.#closed) return;
    this.#clockOffsetMs = offsetMs;
    this.#release();
  }

  /**
   * How far this device has slipped from where the shared clock says it
   * should be, in ms. Positive means running ahead.
   *
   * The expectation comes from the cue this device already holds and the
   * offset it last measured, so reading it costs no traffic and does not
   * depend on the creator answering right now.
   */
  drift(): number {
    if (!this.#playing || this.#originAudioTime === undefined) return 0;
    const sinceStartMs = this.#now() - this.#local(this.#playing.startAt);
    const expected = this.#playing.fromSeconds + sinceStartMs / 1000;
    return (this.position() - expected) * 1000;
  }

  /**
   * Pull the track back towards the shared clock.
   *
   * Small drift is nudged out via playbackRate, which is inaudible and
   * leaves the audio running. Large drift is reseeked, because nudging a
   * gap that size would take minutes of audibly wrong pitch to close.
   *
   * Runs by itself every DRIFT_CHECK_MS while a track is playing.
   */
  correct(): void {
    if (this.#closed || !this.#source || !this.#playing) return;
    const driftMs = this.drift();

    if (Math.abs(driftMs) > DRIFT_RESEEK_MS) {
      // This also clears any nudge in force: #play builds a fresh source,
      // and a fresh source runs at 1. The jump has already closed the gap,
      // so carrying the old rate over would re-open it in the other
      // direction.
      return this.#play(this.#playing);
    }
    // Ahead means slow down. Below the floor the rate goes back to 1 rather
    // than staying nudged: the correction is finished, not merely small.
    const rate = Math.abs(driftMs) <= DRIFT_FLOOR_MS ? 1 : 1 - Math.sign(driftMs) * NUDGE_RATE;
    this.#source.playbackRate.value = rate;
  }

  /**
   * Set the listener's own nudge, and act on it now.
   *
   * For output the browser cannot see the lag of — Bluetooth is 100-300ms
   * late and says nothing. Reseeking mid-track rather than waiting for the
   * next cue is the point: the only way to calibrate it is to drag until it
   * sounds right, which requires hearing the change while dragging.
   */
  setUserOffset(userOffsetMs: number): void {
    if (this.#closed || userOffsetMs === this.#userOffsetMs) return;
    this.#userOffsetMs = userOffsetMs;
    // Only a live track moves; a stopped one simply honours the new value
    // when its next cue arrives.
    if (!this.#playing || !this.#source) return;
    this.#play(this.#playing);
  }

  close(): void {
    this.#closed = true;
    this.#stopSource();
    this.#idle();
    this.#held = undefined;
    this.#listeners.clear();
  }

  /** Act on the held cue, if there is now an offset and — to play — its track. */
  #release(): void {
    const cue = this.#held;
    if (!cue || this.#clockOffsetMs === undefined) return;
    if (cue.type === 'play' && cue.trackId !== this.#track?.id) return;
    this.#held = undefined;
    if (cue.type === 'pause') return this.#pause(this.#local(cue.pauseAt));
    if (cue.type === 'stop') return this.#halt();
    this.#play(cue);
  }

  /** Silence, back at the start. */
  #halt(): void {
    const was = this.#source !== undefined || this.#pausedAt !== 0;
    this.#stopSource();
    this.#idle();
    this.#pausedAt = 0;
    if (was) this.#notify();
  }

  /**
   * An instant on the creator's clock, as an instant on ours.
   *
   * Add the offset to our clock to get the creator's, so subtract it to
   * bring the creator's instant back; then the listener's own nudge on top.
   */
  #local(creatorMs: number): number {
    return creatorMs - (this.#clockOffsetMs ?? 0) + this.#userOffsetMs;
  }

  /**
   * Schedule a start at the cue's instant.
   *
   * A cue whose instant has already passed still plays, from where the track
   * would be by now — a peer whose cue arrived late joins mid-track in sync
   * rather than starting from the beginning, alone.
   */
  #play(cue: PlayCue): void {
    const buffer = this.#track?.buffer;
    if (!buffer) return;
    this.#stopSource();
    const localStartMs = this.#local(cue.startAt);
    const lateBySeconds = Math.max(0, (this.#now() - localStartMs) / 1000);
    const offsetIntoTrack = cue.fromSeconds + lateBySeconds;
    if (offsetIntoTrack >= buffer.duration) {
      // The track would already be over. Nothing to start.
      this.#pausedAt = buffer.duration;
      this.#idle();
      this.#notify();
      return;
    }

    const source = this.#sink.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#sink.destination);

    // The audio clock and the monotonic clock are different clocks; this is
    // the one conversion between them, and it is why scheduling is sample
    // accurate rather than at the mercy of the event loop.
    const when = this.#sink.currentTime + Math.max(0, (localStartMs - this.#now()) / 1000);
    source.start(when, offsetIntoTrack);

    this.#source = source;
    this.#pausedAt = offsetIntoTrack;
    this.#originAudioTime = when - offsetIntoTrack;
    // What drift measures itself against, and what a slider drag moves.
    this.#playing = cue;
    // Slowly on purpose: drift accumulates over minutes, and correcting on
    // a short cadence chases measurement jitter instead.
    this.#stopCorrecting ??= this.#every(DRIFT_CHECK_MS, () => this.correct());
    source.onended = () => {
      // Only if this is still the live source: stopping one to start another
      // fires onended too, and that is not the track finishing.
      if (this.#source !== source) return;
      this.#source = undefined;
      this.#originAudioTime = undefined;
      this.#pausedAt = buffer.duration;
      this.#idle();
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
    this.#pausedAt = Math.min(when - this.#originAudioTime, this.#track?.buffer.duration ?? 0);
    source.onended = null;
    source.stop(when);
    this.#source = undefined;
    this.#originAudioTime = undefined;
    this.#idle();
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

  /** Nothing is playing: no cue in force, and nothing to keep correcting. */
  #idle(): void {
    this.#playing = undefined;
    this.#stopCorrecting?.();
    this.#stopCorrecting = undefined;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
