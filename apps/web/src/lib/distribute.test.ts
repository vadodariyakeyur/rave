import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Distributor, Receiver } from './distribute.ts';
import { send } from './transfer.ts';

/**
 * Who has the file, and how far along. This is what the roster renders and
 * what the Play button reads, so its rules are the ones worth pinning:
 * every connected peer gets served, a peer that drops and comes back is
 * served again, and one peer failing never blocks another.
 */

class FakeChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly #listeners = new Map<string, ((ev: never) => void)[]>();
  peer?: FakeChannel;
  addEventListener(type: string, fn: (ev: never) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (ev: never) => void): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('channel is not open');
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

/** Just enough Mesh for the distributor: channels by peer id, plus notify. */
class FakeMesh {
  readonly channels = new Map<string, RTCDataChannel>();
  readonly #listeners = new Set<() => void>();
  channel(peerId: string): RTCDataChannel | undefined {
    return this.channels.get(peerId);
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  notify(): void {
    for (const l of [...this.#listeners]) l();
  }
}

function bytes(length: number): ArrayBuffer {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out.buffer;
}

/** Long enough for a multi-chunk send to run to completion. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

const file = { bytes: bytes(40_000), fileName: 'track.mp3' };

describe('Distributor', () => {
  it('sends the file to every peer whose channel is open', async () => {
    const mesh = new FakeMesh();
    const a = channel();
    const b = channel();
    const gotA = channel();
    const gotB = channel();
    a.peer = gotA;
    b.peer = gotB;
    mesh.channels.set('a', a);
    mesh.channels.set('b', b);

    const d = new Distributor(mesh as never, file);
    d.sync(['a', 'b']);
    await settle();

    assert.equal(d.transfers().get('a')?.state, 'sent');
    assert.equal(d.transfers().get('b')?.state, 'sent');
    assert.equal(d.transfers().get('a')?.progress, 1);
  });

  it('never calls a peer ready on the strength of its own send', async () => {
    // The barrier reads the server's ready flag, which only the peer sets
    // after decoding. A sender that reported ready here would open the
    // barrier on a device that received nothing — a channel can stay open
    // while the peer is gone, and every byte then lands nowhere.
    const mesh = new FakeMesh();
    const a = channel();
    // No `.peer`: nothing is on the other end, yet the send completes.
    mesh.channels.set('a', a);

    const d = new Distributor(mesh as never, file);
    d.sync(['a']);
    await settle();

    assert.equal(d.transfers().get('a')?.progress, 1);
    assert.notEqual(d.transfers().get('a')?.state, 'ready');
  });

  it('waits for a channel that is not open yet, then sends on notify', async () => {
    // A peer's channel opens well after they appear in the roster. Sending
    // once at sync time would simply skip them.
    const mesh = new FakeMesh();
    const d = new Distributor(mesh as never, file);
    d.sync(['a']);
    await settle();
    assert.equal(d.transfers().get('a')?.state, 'downloading');
    assert.equal(d.transfers().get('a')?.progress, 0);

    const a = channel();
    a.peer = channel();
    mesh.channels.set('a', a);
    mesh.notify();
    await settle();

    assert.equal(d.transfers().get('a')?.state, 'sent');
  });

  it('sends to each peer exactly once while the transfer is in flight', async () => {
    // sync runs on every roster change, and the mesh notifies constantly.
    // Restarting a live transfer would corrupt the one already streaming.
    const mesh = new FakeMesh();
    const a = channel();
    a.peer = channel();
    mesh.channels.set('a', a);
    let headers = 0;
    (a.peer as FakeChannel).addEventListener('message', ((ev: { data: unknown }) => {
      if (typeof ev.data === 'string' && ev.data.includes('file-header')) headers++;
    }) as never);

    const d = new Distributor(mesh as never, file);
    d.sync(['a']);
    d.sync(['a']);
    mesh.notify();
    mesh.notify();
    await settle();

    assert.equal(headers, 1);
  });

  it('marks one peer stalled without touching the other', async () => {
    // A failing peer must not hold up anyone else's download.
    const mesh = new FakeMesh();
    const good = channel();
    good.peer = channel();
    const bad = channel();
    bad.readyState = 'closed';
    mesh.channels.set('good', good);
    mesh.channels.set('bad', bad);

    const d = new Distributor(mesh as never, file);
    d.sync(['good', 'bad']);
    await settle();

    assert.equal(d.transfers().get('good')?.state, 'sent');
    assert.equal(d.transfers().get('bad')?.state, 'stalled');
  });

  it('retries a peer that dropped, once they are back with a fresh channel', async () => {
    // Rejoining is the fix a person will actually try. It has to work.
    const mesh = new FakeMesh();
    const broken = channel();
    broken.readyState = 'closed';
    mesh.channels.set('a', broken);

    const d = new Distributor(mesh as never, file);
    d.sync(['a']);
    await settle();
    assert.equal(d.transfers().get('a')?.state, 'stalled');

    // They rejoin: gone from the roster, then back with a new channel.
    d.sync([]);
    const fresh = channel();
    fresh.peer = channel();
    mesh.channels.set('a', fresh);
    d.sync(['a']);
    await settle();

    assert.equal(d.transfers().get('a')?.state, 'sent');
  });

  it('forgets a peer who left', async () => {
    const mesh = new FakeMesh();
    const a = channel();
    a.peer = channel();
    mesh.channels.set('a', a);
    const d = new Distributor(mesh as never, file);
    d.sync(['a']);
    await settle();

    d.sync([]);
    assert.equal(d.transfers().get('a'), undefined);
  });

  it('notifies subscribers as progress moves', async () => {
    const mesh = new FakeMesh();
    const a = channel();
    a.peer = channel();
    mesh.channels.set('a', a);

    const d = new Distributor(mesh as never, file);
    let notified = 0;
    d.subscribe(() => notified++);
    d.sync(['a']);
    await settle();

    assert.ok(notified > 1, 'a single notify is not live progress');
  });

  it('stops sending once closed', async () => {
    const mesh = new FakeMesh();
    const d = new Distributor(mesh as never, file);
    d.close();

    const a = channel();
    a.peer = channel();
    mesh.channels.set('a', a);
    d.sync(['a']);
    await settle();

    assert.equal(d.transfers().get('a'), undefined);
  });
});

describe('Receiver', () => {
  const creator = 'creator-id';

  /** A joiner's session surface: the context to decode into, and the socket. */
  function fakeSession(decode?: () => Promise<unknown>) {
    const sent: unknown[] = [];
    return {
      sent,
      session: {
        audioContext: {
          decodeAudioData: decode ?? (async () => ({ duration: 30 })),
        } as unknown as AudioContext,
        signaling: { send: (msg: unknown) => sent.push(msg) },
      },
    };
  }

  it('downloads from the creator, decodes, and reports ready', async () => {
    const mesh = new FakeMesh();
    const from = channel();
    const to = channel();
    from.peer = to;
    mesh.channels.set(creator, to);
    const { session, sent } = fakeSession();

    const r = new Receiver(mesh as never, creator, session as never);
    r.start();
    await settle();

    await send(from, file);
    await settle();

    assert.equal(r.transfer().state, 'ready');
    assert.deepEqual(sent, [{ type: 'ready' }]);
    assert.ok(r.result(), 'the decoded track is kept, not just announced');
  });

  it('waits for the creator channel to open rather than giving up', async () => {
    const mesh = new FakeMesh();
    const { session } = fakeSession();
    const r = new Receiver(mesh as never, creator, session as never);
    r.start();
    await settle();
    assert.equal(r.transfer().state, 'downloading');

    const from = channel();
    const to = channel();
    from.peer = to;
    mesh.channels.set(creator, to);
    mesh.notify();
    await settle();
    await send(from, file);
    await settle();

    assert.equal(r.transfer().state, 'ready');
  });

  it('is stalled, not ready, when the file arrives but will not decode', async () => {
    // Received-but-undecoded is not ready: that device would be silent at
    // playback, and the barrier must not clear on its behalf.
    const mesh = new FakeMesh();
    const from = channel();
    const to = channel();
    from.peer = to;
    mesh.channels.set(creator, to);
    const { session, sent } = fakeSession(async () => {
      throw new DOMException('nope', 'EncodingError');
    });

    const r = new Receiver(mesh as never, creator, session as never);
    r.start();
    await settle();
    await send(from, file);
    await settle();

    assert.equal(r.transfer().state, 'stalled');
    assert.deepEqual(sent, [], 'a device that cannot play must never claim ready');
  });

  it('is stalled when the creator drops mid-transfer', async () => {
    const mesh = new FakeMesh();
    const to = channel();
    mesh.channels.set(creator, to);
    const { session } = fakeSession();

    const r = new Receiver(mesh as never, creator, session as never);
    r.start();
    await settle();
    to.close();
    await settle();

    assert.equal(r.transfer().state, 'stalled');
  });

  it('notifies subscribers as the download progresses', async () => {
    const mesh = new FakeMesh();
    const from = channel();
    const to = channel();
    from.peer = to;
    mesh.channels.set(creator, to);
    const { session } = fakeSession();

    const r = new Receiver(mesh as never, creator, session as never);
    let notified = 0;
    r.subscribe(() => notified++);
    r.start();
    await settle();
    await send(from, file);
    await settle();

    assert.ok(notified > 1, 'a single notify is not live progress');
  });
});
