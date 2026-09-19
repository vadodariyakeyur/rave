'use client';

/**
 * How far this device's clock sits from the creator's, measured rather than
 * assumed.
 *
 * NTP's algorithm over the DataChannel the mesh already opened. Nothing here
 * touches the server, and nothing here reads Date.now(): a wall clock is not
 * monotonic (an NTP correction moves it backward mid-track, shifting a
 * scheduled start underneath you) and is unrelated to the audio hardware
 * clock playback is actually scheduled against.
 *
 * performance.now() has a per-document time origin, so a raw reading from
 * one device means nothing on another. That is fine and is the whole trick:
 * the origins cancel in the subtraction below, leaving a real offset.
 */

/** Probes per round. Enough that the lowest-RTT filter has something to pick from. */
const PROBES_PER_ROUND = 20;

/** Between probes in a round — spread out, so one bad moment is not the whole round. */
const PROBE_SPACING_MS = 50;

/**
 * Between rounds. Consumer oscillators drift by milliseconds per minute, so
 * an estimate taken once at join time is wrong by the end of a track.
 */
export const ROUND_INTERVAL_MS = 5_000;

/** A probe unanswered this long is lost: a dropped packet must not wedge a round. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * The share of samples kept, best RTT first.
 *
 * A slow sample is a sample that queued somewhere, and queueing is asymmetric
 * — it inflates the offset estimate as well as the RTT. The fastest samples
 * are the ones that spent the least time being lied to.
 */
const KEEP_FRACTION = 0.25;

/** Probe, peer -> creator. `id` comes back untouched so the reply can be matched. */
export interface ClockPing {
  type: 'clock-ping';
  id: number;
  /** The sender's own monotonic clock. Meaningless to the receiver, echoed back. */
  t0: number;
}

/** Reply, creator -> peer. t1 and t2 are both the creator's clock. */
export interface ClockPong {
  type: 'clock-pong';
  id: number;
  t0: number;
  /** When the creator saw the ping. */
  t1: number;
  /** When the creator sent this reply. Not equal to t1: serialising takes time. */
  t2: number;
}

export interface Sample {
  rtt: number;
  offset: number;
}

/** What the debug overlay renders. */
export interface Estimate {
  /** Add this to our clock to get the creator's. Undefined until a round lands. */
  offsetMs: number | undefined;
  /** Round-trip of the samples that were kept, best first. */
  rttsMs: readonly number[];
  /** Samples in the last completed round, before filtering. */
  sampleCount: number;
}

/**
 * Turn one round's samples into an offset.
 *
 * Median, not mean: one sample that queued behind a video frame skews a mean
 * by more than every good sample corrects for, and the whole point of the
 * lowest-RTT filter is to be robust to exactly that.
 */
export function estimate(samples: readonly Sample[]): Estimate {
  if (samples.length === 0) return { offsetMs: undefined, rttsMs: [], sampleCount: 0 };

  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
  // At least one, or a short round would filter itself down to nothing.
  const keep = Math.max(1, Math.round(byRtt.length * KEEP_FRACTION));
  const best = byRtt.slice(0, keep);

  return {
    offsetMs: median(best.map((s) => s.offset)),
    rttsMs: best.map((s) => s.rtt),
    sampleCount: samples.length,
  };
}

/** The even case averages the middle pair rather than leaning arbitrarily low. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * One probe's arithmetic.
 *
 * rtt    = total elapsed here, minus the time the creator spent holding it
 * offset = the average of the two one-way disagreements, which cancels the
 *          per-document time origins and leaves the clock difference
 *
 * Assumes the path is symmetric. It is not, quite, and that asymmetry is the
 * error floor — hence keeping only the fastest samples, where it is smallest.
 */
export function sampleOf(pong: ClockPong, t3: number): Sample {
  return {
    rtt: t3 - pong.t0 - (pong.t2 - pong.t1),
    offset: (pong.t1 - pong.t0 + (pong.t2 - t3)) / 2,
  };
}

/** Narrow an arbitrary channel message to a ping. Shared wire: #5 is on it too. */
export function asPing(data: unknown): ClockPing | undefined {
  const value = parse(data);
  if (!value || value.type !== 'clock-ping') return undefined;
  return typeof value.id === 'number' && typeof value.t0 === 'number'
    ? (value as unknown as ClockPing)
    : undefined;
}

/** Narrow an arbitrary channel message to a pong. */
export function asPong(data: unknown): ClockPong | undefined {
  const value = parse(data);
  if (!value || value.type !== 'clock-pong') return undefined;
  return ['id', 't0', 't1', 't2'].every((k) => typeof value[k] === 'number')
    ? (value as unknown as ClockPong)
    : undefined;
}

function parse(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined; // A file chunk. Not ours.
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answer clock pings on a channel. The creator's whole side of this.
 *
 * t1 is taken before anything else happens and t2 immediately before the
 * send, so the reply carries how long we actually held it rather than
 * pretending that was free.
 */
export function serveClock(
  channel: RTCDataChannel,
  now: () => number = () => performance.now(),
): () => void {
  const onMessage = (event: MessageEvent) => {
    const t1 = now();
    const ping = asPing(event.data);
    if (!ping) return;
    const pong: ClockPong = { type: 'clock-pong', id: ping.id, t0: ping.t0, t1, t2: now() };
    // A channel that closed between the ping and here throws on send, and a
    // clock reply is not worth taking anything else down for.
    try {
      channel.send(JSON.stringify(pong));
    } catch {
      // The peer is gone. Their next round, if any, opens a new channel.
    }
  };
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}

/**
 * Reading the clock and waiting on it, together.
 *
 * One seam rather than two: a test that fakes `now` but not `sleep` measures
 * synthetic microseconds while waiting real seconds, which is how this spent
 * forty seconds per lost round the first time round.
 */
export interface Clock {
  now: () => number;
  /** Resolves after roughly `ms`. Returns a canceller, so close() is immediate. */
  sleep: (ms: number, resolve: () => void) => () => void;
}

const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, resolve) => {
    const timer = setTimeout(resolve, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * The peer's side: probe the creator, hold a live estimate.
 *
 * Rounds repeat for as long as this is open, because the answer changes.
 * A round that loses every probe leaves the previous estimate standing —
 * a stale offset is worth more than no offset, and the overlay shows the
 * sample count so a dying link is visible.
 */
export class ClockProbe {
  readonly #channel: RTCDataChannel;
  readonly #clock: Clock;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<number, (pong: ClockPong) => void>();
  #estimate: Estimate = { offsetMs: undefined, rttsMs: [], sampleCount: 0 };
  #nextId = 1;
  #closed = false;
  #detach: (() => void) | undefined;
  /** Cancels whatever wait is outstanding, so close() does not leave one running. */
  #cancelWait: (() => void) | undefined;

  constructor(channel: RTCDataChannel, clock: Clock = realClock) {
    this.#channel = channel;
    this.#clock = clock;
  }

  estimate(): Estimate {
    return this.#estimate;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#detach || this.#closed) return;
    const onMessage = (event: MessageEvent) => {
      const t3 = this.#clock.now();
      const pong = asPong(event.data);
      if (!pong) return;
      // Unknown id: a reply to a probe that already timed out. Its round has
      // been scored, so folding it in now would mix two rounds.
      this.#pending.get(pong.id)?.(pong);
    };
    this.#channel.addEventListener('message', onMessage);
    this.#detach = () => this.#channel.removeEventListener('message', onMessage);
    void this.#loop();
  }

  close(): void {
    this.#closed = true;
    this.#detach?.();
    this.#detach = undefined;
    this.#cancelWait?.();
    this.#cancelWait = undefined;
    this.#pending.clear();
    this.#listeners.clear();
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      const samples = await this.#round();
      if (this.#closed) return;
      // An empty round keeps the last estimate: see the class comment.
      if (samples.length > 0) {
        this.#estimate = estimate(samples);
        for (const listener of [...this.#listeners]) listener();
      }
      await this.#wait(ROUND_INTERVAL_MS);
    }
  }

  async #round(): Promise<Sample[]> {
    const samples: Sample[] = [];
    for (let i = 0; i < PROBES_PER_ROUND && !this.#closed; i++) {
      const sample = await this.#probe();
      if (sample) samples.push(sample);
      if (i < PROBES_PER_ROUND - 1) await this.#wait(PROBE_SPACING_MS);
    }
    return samples;
  }

  #probe(): Promise<Sample | undefined> {
    if (this.#channel.readyState !== 'open') return Promise.resolve(undefined);
    const id = this.#nextId++;

    return new Promise<Sample | undefined>((resolve) => {
      const settle = (sample: Sample | undefined) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(sample);
      };
      const timer = setTimeout(() => settle(undefined), PROBE_TIMEOUT_MS);
      this.#pending.set(id, (pong) => settle(sampleOf(pong, this.#clock.now())));

      const ping: ClockPing = { type: 'clock-ping', id, t0: this.#clock.now() };
      try {
        this.#channel.send(JSON.stringify(ping));
      } catch {
        // Channel died under us. One lost sample, not a lost round.
        settle(undefined);
      }
    });
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#cancelWait = this.#clock.sleep(ms, resolve);
    });
  }
}
