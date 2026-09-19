import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { receive, send, STALL_MS, type Transfer } from './transfer.ts';

/**
 * The transfer's own rules: that a receiver gets back exactly the bytes that
 * went in whatever the chunking, that the sender reports progress the roster
 * can show, and that a peer which stops acking is called stalled rather than
 * left at 40% forever.
 *
 * RTCDataChannel is faked because none of that is the browser's behaviour.
 */

class FakeChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: (string | ArrayBuffer)[] = [];
  readonly #listeners = new Map<string, ((ev: never) => void)[]>();
  /** Set to route everything this channel sends into another channel. */
  peer?: FakeChannel;

  addEventListener(type: string, fn: (ev: never) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (ev: never) => void): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** When true the channel never drains, as a wedged one does not. */
  wedged = false;
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
    if (this.wedged) {
      this.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength;
      return;
    }
    this.peer?.deliver(data);
  }
  deliver(data: unknown): void {
    for (const fn of [...(this.#listeners.get('message') ?? [])]) {
      (fn as (ev: { data: unknown }) => void)({ data });
    }
  }
  close(): void {
    this.readyState = 'closed';
    for (const fn of [...(this.#listeners.get('close') ?? [])]) (fn as () => void)();
  }
}

const channel = () => new FakeChannel() as unknown as RTCDataChannel & FakeChannel;

/** Bytes that are recognisably themselves at every offset. */
function bytes(length: number): ArrayBuffer {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out.buffer;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Let the send loop run until it is parked on a drain it cannot pass.
 *
 * Its chunk loop awaits, so a tick or a close fired in the same turn lands
 * before the sender is listening for either.
 */
const drained = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

describe('transfer', () => {
  it('delivers exactly the bytes that were sent, across many chunks', async () => {
    const from = channel();
    const to = channel();
    from.peer = to;
    to.peer = from;

    const source = bytes(70_000);
    const received = receive(to);
    await send(from, { bytes: source, fileName: 'track.mp3' });
    const result = await received;

    assert.equal(result.fileName, 'track.mp3');
    assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array(source));
  });

  it('delivers a file smaller than one chunk', async () => {
    const from = channel();
    const to = channel();
    from.peer = to;
    to.peer = from;

    const source = bytes(10);
    const received = receive(to);
    await send(from, { bytes: source, fileName: 't.wav' });
    assert.deepEqual(new Uint8Array((await received).bytes), new Uint8Array(source));
  });

  it('reports progress from 0 to 1 on both ends', async () => {
    const from = channel();
    const to = channel();
    from.peer = to;
    to.peer = from;

    const sent: number[] = [];
    const got: number[] = [];
    const received = receive(to, (p) => got.push(p));
    await send(from, { bytes: bytes(70_000), fileName: 't.mp3' }, (p) => sent.push(p));
    await received;

    assert.ok(sent.length > 1, 'a single 100% jump is not progress');
    assert.equal(sent.at(-1), 1);
    assert.ok(got.length > 1);
    assert.equal(got.at(-1), 1);
    // Monotonic: a bar that goes backwards reads as a bug to the person watching.
    assert.deepEqual(sent, [...sent].sort((a, b) => a - b));
    assert.deepEqual(got, [...got].sort((a, b) => a - b));
  });

  it('calls a peer stalled when the channel stops draining', async () => {
    // The sender owns this: it knows when the buffer last moved. A peer that
    // has gone quiet must not sit at 40% while the host waits on it.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const from = channel();
      // Never drains and never fires bufferedamountlow: a wedged channel.
      from.wedged = true;

      // Bigger than the high-water mark, so the sender actually has to wait.
      const result = send(from, { bytes: bytes(2_000_000), fileName: 't.mp3' });
      const rejected = assert.rejects(result, /stalled/i);

      // The send loop awaits between chunks; the timer only starts once it
      // has filled the buffer and reached a drain it cannot pass.
      await drained();
      mock.timers.tick(STALL_MS + 1);
      await rejected;
    } finally {
      mock.timers.reset();
    }
  });

  it('fails rather than hanging when the channel closes mid-transfer', async () => {
    const from = channel();
    from.wedged = true;
    const result = send(from, { bytes: bytes(2_000_000), fileName: 't.mp3' });
    const rejected = assert.rejects(result, /closed/i);

    await drained();
    from.close();
    await rejected;
  });

  it('ignores a message that is not part of a transfer', async () => {
    // #6 puts clock probes on this same channel; a receiver must not choke
    // on one, or treat it as audio.
    const to = channel();
    const received = receive(to);
    to.deliver(JSON.stringify({ type: 'clock-probe', t0: 1 }));
    to.deliver('not json at all');

    const from = channel();
    from.peer = to;
    const source = bytes(100);
    await send(from, { bytes: source, fileName: 't.mp3' });
    assert.deepEqual(new Uint8Array((await received).bytes), new Uint8Array(source));
  });
});

/** The type is part of the contract the roster renders. */
const _typeCheck: Transfer = { progress: 0, state: 'downloading' };
void _typeCheck;
