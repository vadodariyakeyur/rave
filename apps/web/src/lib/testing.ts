import type { Clock } from './clock.ts';
import { ChannelLink } from './link.ts';

/**
 * Fakes shared by the tests of everything that talks to a peer.
 *
 * The channel is the only thing faked: the link over it is the real one, so
 * a test of the clock or the file is also a test that they share a wire.
 */

export class FakeChannel {
  readyState: RTCDataChannelState;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: (string | ArrayBuffer)[] = [];
  /** Set to route everything this channel sends into another channel. */
  peer?: FakeChannel;
  readonly #listeners = new Map<string, Set<(ev: never) => void>>();

  constructor(readyState: RTCDataChannelState = 'open') {
    this.readyState = readyState;
  }

  addEventListener(type: string, fn: (ev: never) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: never) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('channel is not open');
    this.sent.push(data);
    this.peer?.deliver(data);
  }
  /** As if this arrived from the other end. */
  deliver(data: unknown): void {
    this.#emit('message', { data });
  }
  open(): void {
    this.readyState = 'open';
    this.#emit('open', {});
  }
  close(): void {
    this.readyState = 'closed';
    this.#emit('close', {});
  }
  /** The JSON messages sent so far, parsed. */
  messages(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === 'string')
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }
  #emit(type: string, ev: unknown): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) (fn as (ev: unknown) => void)(ev);
  }
}

export const channel = (readyState: RTCDataChannelState = 'open') =>
  new FakeChannel(readyState) as unknown as RTCDataChannel & FakeChannel;

/** A link over a fresh channel, and the channel to drive it by. */
export function link(readyState: RTCDataChannelState = 'open') {
  const wire = channel(readyState);
  const made = new ChannelLink();
  made.attach(wire);
  return { link: made, channel: wire };
}

/** Two links whose channels deliver into each other. */
export function linked() {
  const a = link();
  const b = link();
  a.channel.peer = b.channel;
  b.channel.peer = a.channel;
  return { a, b };
}

/** Just enough mesh for anything that reaches peers by id. */
export class FakeMesh {
  readonly #links = new Map<string, ChannelLink>();
  link(peerId: string): ChannelLink {
    let made = this.#links.get(peerId);
    if (!made) this.#links.set(peerId, (made = new ChannelLink()));
    return made;
  }
  /** The peer's channel exists now. Returns it, already attached. */
  connect(peerId: string, readyState: RTCDataChannelState = 'open') {
    const wire = channel(readyState);
    this.link(peerId).attach(wire);
    return wire;
  }
}

/** Bytes that are recognisably themselves at every offset. */
export function bytes(length: number): ArrayBuffer {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out.buffer;
}

/**
 * A clock the test drives. Sleepers are kept in a queue and released by
 * advancing past their deadline, so a round that loses every probe to a 2s
 * timeout costs nothing in wall time.
 */
export function virtualClock(start = 0) {
  let t = start;
  let seq = 0;
  const waiting = new Map<number, { at: number; resolve: () => void }>();
  const clock: Clock & { advance: (ms: number) => void } = {
    now: () => t,
    sleep: (ms, resolve) => {
      const id = seq++;
      waiting.set(id, { at: t + ms, resolve });
      return () => waiting.delete(id);
    },
    advance: (ms) => {
      t += ms;
      for (const [id, w] of [...waiting]) {
        if (w.at > t) continue;
        waiting.delete(id);
        w.resolve();
      }
    },
  };
  return clock;
}

/** Step time in small slices so each queued sleeper fires in order. */
export async function step(clock: ReturnType<typeof virtualClock>, ms: number): Promise<void> {
  for (let i = 0; i < ms; i += 10) {
    clock.advance(10);
    // Let the promise chains waiting on the clock actually progress.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}
