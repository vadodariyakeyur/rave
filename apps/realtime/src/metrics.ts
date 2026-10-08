import { Registry, Gauge } from '@prometheus-io/client';

/**
 * What the operator needs to see, and nothing else.
 *
 * A single-instance in-memory service does not need traces or spans: there
 * is one process and no downstream call to follow. Two numbers answer what
 * this stack can be asked — how many rooms are live, and how many people are
 * in them.
 *
 * Both are derived state rather than events, so they are gauges read from
 * the registry at scrape time. Incrementing a counter at every join and
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

  readonly roomsLive: Gauge;

  readonly peersLive: Gauge;

  constructor(live: LiveCounts = { size: 0, peerCount: 0 }) {
    this.roomsLive = new Gauge({
      name: 'rave_rooms_live',
      help: 'Rooms currently live',
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
  }

  /** The Prometheus text exposition, for the /metrics route. */
  async render(): Promise<{ body: string; contentType: string }> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}
