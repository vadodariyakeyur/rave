import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Peer, ServerMessage } from '@rave/protocol';
import { Mesh } from './mesh.ts';
import type { Signaling } from './signaling.ts';

/**
 * The mesh's own rules, not the browser's: who offers, what happens to a
 * candidate that beats its answer, and whether a departed peer is really
 * gone. RTCPeerConnection is stubbed because those rules have to hold
 * regardless of what any one browser does with the SDP.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const pcs: FakePeerConnection[] = [];

class FakeDataChannel {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: unknown = null;
  localDescription = { type: 'offer', toJSON: () => ({ type: 'offer', sdp: 'local' }) };
  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: unknown[] = [];
  closedCount = 0;
  readonly #listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(readonly config: RTCConfiguration) {
    pcs.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev);
  }
  readonly channelOptions: (RTCDataChannelInit | undefined)[] = [];
  createDataChannel(_label: string, options?: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    this.channelOptions.push(options);
    // The real one fires negotiationneeded asynchronously; the mesh relies
    // on that event rather than offering inline, so the fake must fire it.
    queueMicrotask(() => this.emit('negotiationneeded'));
    return channel;
  }
  /** Set by a test to make the next negotiation step reject. */
  failNegotiation = false;
  async createOffer() {
    if (this.failNegotiation) throw new Error('negotiation failed');
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer() {
    this.localDescription = { type: 'answer', toJSON: () => ({ type: 'answer', sdp: 'local' }) };
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(d: unknown): Promise<void> {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown): Promise<void> {
    this.addedCandidates.push(c);
  }
  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.emit('connectionstatechange');
  }
  close(): void {
    this.closedCount++;
  }
}

/** Captures what the mesh would put on the wire, and lets a test push back. */
class FakeSignaling {
  readonly sent: { to: string; data: unknown }[] = [];
  #handler: ((msg: ServerMessage) => void) | undefined;
  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = undefined;
    };
  }
  send(msg: { type: string; to: string; data: unknown }): void {
    this.sent.push({ to: msg.to, data: msg.data });
  }
  deliver(from: string, data: unknown): void {
    this.#handler?.({ type: 'signal', from, data } as ServerMessage);
  }
}

function peer(peerId: string): Peer {
  return { peerId, displayName: peerId.slice(0, 4), isCreator: false, ready: false };
}

function meshFor(selfPeerId: string) {
  const signaling = new FakeSignaling();
  const mesh = new Mesh({
    signaling: signaling as unknown as Signaling,
    selfPeerId,
    iceServers: [{ urls: 'stun:example:1' }],
  });
  return { mesh, signaling };
}

/** Let queued microtasks (negotiationneeded, the offer chain) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const realRTC = globalThis.RTCPeerConnection;

beforeEach(() => {
  pcs.length = 0;
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
});
afterEach(() => {
  globalThis.RTCPeerConnection = realRTC;
});

describe('Mesh', () => {
  it('opens one connection per other peer and never to itself', () => {
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B), peer(C)]);
    assert.equal(pcs.length, 2);
    assert.deepEqual([...mesh.states().keys()].sort(), [B, C].sort());
  });

  it('is idempotent, so a repeated roster does not rebuild the mesh', () => {
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    mesh.sync([peer(A), peer(B)]);
    assert.equal(pcs.length, 1);
  });

  it('offers only from the lower peer id, so both sides do not offer at once', async () => {
    // Glare: both peers see the same roster at the same instant. Without a
    // deterministic rule each would offer and each would reject the other's.
    const lower = meshFor(A);
    lower.mesh.sync([peer(A), peer(B)]);
    const higher = meshFor(B);
    higher.mesh.sync([peer(A), peer(B)]);
    await settle();

    assert.equal(lower.signaling.sent.length, 1, 'lower id should offer');
    assert.equal(higher.signaling.sent.length, 0, 'higher id should wait');
  });

  it('answers an offer that arrives before the roster does', async () => {
    const { mesh, signaling } = meshFor(B);
    signaling.deliver(A, { description: { type: 'offer', sdp: 'x' } });
    await settle();

    assert.equal(pcs.length, 1);
    const [reply] = signaling.sent;
    assert.equal(reply?.to, A);
    assert.equal((reply?.data as { description: { type: string } }).description.type, 'answer');
    void mesh;
  });

  it('queues candidates that beat the remote description, then applies them', async () => {
    // On a LAN candidates routinely arrive before the answer, and applying
    // one without a remote description throws.
    const { mesh, signaling } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    await settle();
    const pc = pcs[0]!;

    signaling.deliver(B, { candidate: { candidate: 'early' } });
    await settle();
    assert.equal(pc.addedCandidates.length, 0, 'must not apply before the description');

    signaling.deliver(B, { description: { type: 'answer', sdp: 'y' } });
    await settle();
    assert.deepEqual(pc.addedCandidates, [{ candidate: 'early' }]);
  });

  it('reports a failed connection distinctly from a peer who left', async () => {
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    pcs[0]!.setConnectionState('connected');
    assert.equal(mesh.states().get(B), 'connected');

    pcs[0]!.setConnectionState('failed');
    assert.equal(mesh.states().get(B), 'failed');
  });

  it('keeps a briefly disconnected peer as connecting, not failed', () => {
    // ICE reports 'disconnected' on a blip it usually recovers from; calling
    // that a failure would flash an error at someone whose wifi hiccuped.
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    pcs[0]!.setConnectionState('disconnected');
    assert.equal(mesh.states().get(B), 'connecting');
  });

  it('gives up on a connection that never lands, rather than saying connecting forever', () => {
    // ICE does not always reach 'failed': with no candidate pair possible it
    // stays in checking and fires no further event, so the only signal that
    // something is wrong is that nothing happened.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { mesh } = meshFor(A);
      mesh.sync([peer(A), peer(B)]);
      assert.equal(mesh.states().get(B), 'connecting');

      mock.timers.tick(15_000);
      assert.equal(mesh.states().get(B), 'failed');
    } finally {
      mock.timers.reset();
    }
  });

  it('does not fail a connection that came up in time', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { mesh } = meshFor(A);
      mesh.sync([peer(A), peer(B)]);
      pcs[0]!.setConnectionState('connected');

      mock.timers.tick(60_000);
      assert.equal(mesh.states().get(B), 'connected');
    } finally {
      mock.timers.reset();
    }
  });

  it('tears down the connection and the row when a peer leaves the roster', async () => {
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    await settle();
    const pc = pcs[0]!;

    mesh.sync([peer(A)]);
    assert.equal(pc.closedCount, 1);
    assert.equal(pc.channels[0]?.closed, true);
    // A 'closed' row is a row for someone who is not in the room.
    assert.equal(mesh.states().has(B), false);
  });

  it('gives a rejoining peer a fresh connection', async () => {
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    await settle();
    mesh.sync([peer(A)]);
    mesh.sync([peer(A), peer(B)]);
    await settle();

    assert.equal(pcs.length, 2, 'the stale connection must not be reused');
    assert.equal(mesh.states().get(B), 'connecting');
  });

  it('closes everything and stops listening on close', async () => {
    const { mesh, signaling } = meshFor(A);
    mesh.sync([peer(A), peer(B), peer(C)]);
    await settle();

    mesh.close();
    assert.deepEqual(pcs.map((pc) => pc.closedCount), [1, 1]);

    const before = pcs.length;
    signaling.deliver(B, { description: { type: 'offer', sdp: 'x' } });
    await settle();
    assert.equal(pcs.length, before, 'a closed mesh must not resurrect on a stray signal');
  });

  it('asks for a reliable ordered channel', async () => {
    // #5 sends the audio file over this and #6 the clock probes. Partial
    // reliability would corrupt both in ways that look like a sync bug, so
    // the guarantee is asserted rather than inherited from a default.
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    await settle();

    assert.deepEqual(pcs[0]!.channelOptions, [{ ordered: true }]);
  });

  it('reports a negotiation that throws as failed', async () => {
    // Unhandled, a rejected SDP call leaves the peer at 'connecting' with
    // nothing on screen saying why — and past the timeout, forever.
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    pcs[0]!.failNegotiation = true;
    await settle();

    assert.equal(mesh.states().get(B), 'failed');
  });

  it('does not report a failure for a peer torn down mid-negotiation', async () => {
    // A teardown while an offer is in flight is an ordinary cancellation.
    const { mesh } = meshFor(A);
    mesh.sync([peer(A), peer(B)]);
    pcs[0]!.failNegotiation = true;
    mesh.sync([peer(A)]);
    await settle();

    assert.equal(mesh.states().has(B), false, 'a departed peer must leave no row');
  });
});
