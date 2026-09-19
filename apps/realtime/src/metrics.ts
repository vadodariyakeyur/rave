import { Registry, Counter, Gauge, Histogram } from '@prometheus-io/client';

/**
 * What the operator needs to see, and nothing else.
 *
 * A single-instance in-memory service does not need traces or spans: there
 * is one process and no downstream call to follow. Four numbers answer every
 * question this stack can be asked — how many rooms are live, how many people
 * are in them, how long the ready-barrier makes everyone wait, and how often
 * someone gives up on a stuck peer.
 *
 * Two of those are derived state rather than events, so they are gauges read
 * from the registry at scrape time. Incrementing a counter at every join and
 * leave would be a second copy of the roster, free to drift from the real one.
 */

/**
 * Where the live counts are read from at scrape time.
 *
 * A structural type rather than the registry itself: metrics should not
 * depend on the room model, and everything it needs is two numbers.
 */
export interface LiveCounts {
  readonly size: number;
  readonly peerCount: number;
}

/** Its own registry, not the global one: a test can build a clean set. */
export class Metrics {
  readonly registry = new Registry();

  /**
   * Create to all-ready, in seconds.
   *
   * Buckets stop at 120s because the barrier is a LAN file transfer — past
   * two minutes the answer is "a peer is stuck", which the force-start
   * counter already records, and finer resolution up there buys nothing.
   */
  readonly barrierWaitSeconds = new Histogram({
    name: 'rave_barrier_wait_seconds',
    help: 'Seconds from room creation until every peer reported ready',
    buckets: [1, 2, 5, 10, 20, 30, 60, 120],
    registers: [this.registry],
  });

  /** Forced starts, against total starts — the ratio is the interesting part. */
  readonly startsTotal = new Counter({
    name: 'rave_starts_total',
    help: 'Playback starts, labelled by whether peers were left behind',
    labelNames: ['forced'] as const,
    registers: [this.registry],
  });

  readonly roomsLive: Gauge;

  readonly peersLive: Gauge;

  constructor(live: LiveCounts = { size: 0, peerCount: 0 }) {
    this.roomsLive = new Gauge({
      name: 'rave_rooms_live',
      help: 'Rooms currently open or locked',
      registers: [this.registry],
      collect() {
        this.set(live.size);
      },
    });

    this.peersLive = new Gauge({
      name: 'rave_peers_live',
      help: 'Peers currently in a room',
      registers: [this.registry],
      collect() {
        this.set(live.peerCount);
      },
    });

    // Both label values must exist before the first force-start, or
    // rate(forced) has no series to compare against and the dashboard
    // renders empty instead of zero.
    this.startsTotal.inc({ forced: 'true' }, 0);
    this.startsTotal.inc({ forced: 'false' }, 0);
  }

  /** The Prometheus text exposition, for the /metrics route. */
  async render(): Promise<{ body: string; contentType: string }> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}

/**
 * Times the ready-barrier: room creation until the last peer reports ready.
 *
 * Kept out of RoomRegistry deliberately. The registry answers who is in a
 * room; making it also own a clock and a histogram would mean every caller
 * that mutates a roster has to care about reporting.
 *
 * Monotonic, not wall-clock: this is a duration, and an NTP correction
 * mid-barrier would otherwise record a negative wait.
 */
export class BarrierTimer {
  readonly #startedAt = new Map<string, number>();
  readonly #now: () => number;
  readonly #observe: (seconds: number) => void;

  // Wrapped, not passed bare: performance.now needs its receiver, and
  // calling a detached copy as this.#now() rebinds it to the timer.
  constructor(observe: (seconds: number) => void, now: () => number = () => performance.now()) {
    this.#observe = observe;
    this.#now = now;
  }

  /** A room opened. The barrier clock starts even though nobody is waiting yet. */
  open(code: string): void {
    this.#startedAt.set(code, this.#now());
  }

  /**
   * A roster changed. Records the wait the first time every peer is ready.
   *
   * Only counts once a second peer has joined: a creator is born ready, so
   * an empty room is trivially "all ready", and recording that would bury
   * the real waits under a pile of zeroes.
   */
  settle(code: string, peers: readonly { ready: boolean }[]): void {
    const startedAt = this.#startedAt.get(code);
    if (startedAt === undefined) return;
    if (peers.length < 2 || !peers.every((p) => p.ready)) return;
    // Delete before observing, so the barrier is recorded once even if a
    // peer leaves and the survivors are still all ready.
    this.#startedAt.delete(code);
    this.#observe((this.#now() - startedAt) / 1000);
  }

  /** The room is gone, whether it ever settled or not. */
  close(code: string): void {
    this.#startedAt.delete(code);
  }
}
