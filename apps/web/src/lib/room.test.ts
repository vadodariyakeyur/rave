import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, Peer, RoomState, ServerMessage } from '@rave/protocol';
import { serveClock } from './clock.ts';
import { ChannelLink } from './link.ts';
import type { PeerConnectionState } from './mesh.ts';
import { START_LEAD_MS, type Every } from './player.ts';
import { LiveRoom, type RoomDeps } from './room.ts';
import { bytes, FakeChannel, FakeMesh, step, virtualClock } from './testing.ts';
import { send } from './transfer.ts';

/**
 * The room's ordering rules, through the one interface the screen uses.
 *
 * Each part underneath has its own tests; what none of them can pin is what
 * happens between them — a cue that beats the track it starts, a roster
 * change in the middle of a transfer, a room that ends twice. Those used to
 * live in the dependency arrays of a component, where nothing could reach
 * them. Faked here: the server socket, the peers' channels, the audio device
 * and the clock. Everything in between is the real thing.
 */

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

function peer(peerId: string, extra: Partial<Peer> = {}): Peer {
  return { peerId, displayName: peerId.slice(0, 4), isCreator: peerId === HOST, ready: peerId === HOST, ...extra };
}

function roster(peerIds: string[], locked = false): RoomState {
  return { type: 'room-state', code: 'ABC234', roomName: 'Kitchen', locked, peers: peerIds.map((id) => peer(id)) };
}

class FakeSignaling {
  readonly sent: ClientMessage[] = [];
  closed = false;
  readonly #handlers = new Set<(msg: ServerMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }
  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }
  close(): void {
    this.closed = true;
  }
  deliver(msg: ServerMessage): void {
    for (const handler of [...this.#handlers]) handler(msg);
  }
  drop(): void {
    for (const handler of [...this.#closeHandlers]) handler();
  }
}

/** The mesh, as far as the room is concerned: links by peer id, and a roster to follow. */
class RoomMesh extends FakeMesh {
  readonly synced: string[][] = [];
  closed = false;
  states(): ReadonlyMap<string, PeerConnectionState> {
    return new Map();
  }
  subscribe(): () => void {
    return () => {};
  }
  sync(peers: readonly Peer[]): void {
    this.synced.push(peers.map((p) => p.peerId));
  }
  close(): void {
    this.closed = true;
  }
  /** A peer's channel, with a far end to stand in for their device. */
  wire(peerId: string) {
    const near = this.connect(peerId);
    const far = new FakeChannel();
    near.peer = far;
    far.peer = near;
    return { near, far: far as unknown as RTCDataChannel & FakeChannel };
  }
}

/** An audio device that records what was scheduled on it. */
function audio() {
  const sources: { started?: { when: number; offset: number }; stopped?: number }[] = [];
  const self = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    sources,
    closed: false,
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        playbackRate: { value: 1 },
        started: undefined as { when: number; offset: number } | undefined,
        stopped: undefined as number | undefined,
        connect() {},
        start(when: number, offset: number) {
          source.started = { when, offset };
        },
        stop(when?: number) {
          source.stopped = when ?? self.currentTime;
        },
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    async decodeAudioData() {
      return { duration: 30 } as AudioBuffer;
    },
    async close() {
      self.closed = true;
    },
  };
  return self;
}

const noTimers: Every = () => () => {};

/** Long enough for a multi-chunk transfer and its decode to run through. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

const file = { bytes: bytes(40_000), fileName: 'track.mp3' };

function setup(self: string, peerIds: string[]) {
  const signaling = new FakeSignaling();
  const mesh = new RoomMesh();
  const out = audio();
  const clock = virtualClock(1_000);
  const deps: RoomDeps = { createMesh: () => mesh, clock, every: noTimers };
  const room = new LiveRoom(
    {
      signaling,
      audioContext: out as never,
      entered: { peerId: self, iceServers: [], state: roster(peerIds) },
      file:
        self === HOST
          ? { buffer: { duration: 60 } as AudioBuffer, bytes: file.bytes, fileName: file.fileName }
          : undefined,
    },
    deps,
  );
  return { signaling, mesh, out, clock, room };
}

describe('a joiner', () => {
  /** How far ahead of ours the creator's clock runs. */
  const AHEAD = 40_000;

  function joiner() {
    const ctx = setup(GUEST, [HOST, GUEST]);
    const { near, far } = ctx.mesh.wire(HOST);
    // The creator's device: answers clock pings on its own clock.
    const host = new ChannelLink();
    host.attach(far);
    const hostNow = () => ctx.clock.now() + AHEAD;
    serveClock(host, hostNow);
    return {
      ...ctx,
      near,
      far,
      hostNow,
      /** One full probe round. */
      measure: () => step(ctx.clock, 1_500),
      /** The creator's file arrives and decodes. */
      download: async () => {
        await settle();
        await send(far, file);
        await settle();
      },
      cue: (msg: object) => near.deliver(JSON.stringify(msg)),
    };
  }

  it('downloads, decodes, has a track to show, and only then says ready', async () => {
    const { room, signaling, download } = joiner();
    assert.equal(room.snapshot().track, undefined);
    assert.deepEqual(signaling.sent, []);

    await download();

    assert.deepEqual(room.snapshot().track, { fileName: 'track.mp3', durationSeconds: 30 });
    assert.equal(room.snapshot().transfers.get(GUEST)?.state, 'ready');
    assert.deepEqual(signaling.sent, [{ type: 'ready' }]);
  });

  it('measures its clock against the creator and shows the estimate', async () => {
    const { room, measure } = joiner();
    assert.equal(room.snapshot().estimate, undefined);
    await measure();
    assert.equal(room.snapshot().estimate?.offsetMs, AHEAD);
  });

  it('starts on the cue, at the creator\'s instant on its own clock', async () => {
    const { room, out, hostNow, measure, download, cue } = joiner();
    await measure();
    await download();

    cue({ type: 'play', startAt: hostNow() + START_LEAD_MS, fromSeconds: 0 });

    assert.equal(out.sources.length, 1);
    assert.deepEqual(out.sources[0]!.started, { when: START_LEAD_MS / 1000, offset: 0 });
    assert.equal(room.snapshot().playing, true);
  });

  it('plays a cue that beat the track, from where the room has got to', async () => {
    // The start cue is one send with no replay. A device still decoding
    // when it lands must not sit silent for the rest of the track.
    const { room, out, clock, hostNow, measure, download, cue } = joiner();
    await measure();

    cue({ type: 'play', startAt: hostNow(), fromSeconds: 0 });
    assert.equal(out.sources.length, 0, 'nothing to play yet');

    clock.advance(2_000);
    await download();

    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0]!.started?.offset, 2, 'two seconds in, with everyone else');
    assert.equal(room.snapshot().playing, true);
  });

  it('holds a cue that beat the first clock measurement, instead of guessing', async () => {
    // A small file on a fast network is ready before the first probe round
    // lands. Playing at an unmeasured offset is playing at a random time.
    const { out, hostNow, measure, download, cue } = joiner();
    await download();

    cue({ type: 'play', startAt: hostNow() + START_LEAD_MS, fromSeconds: 0 });
    assert.equal(out.sources.length, 0);

    await measure();
    assert.equal(out.sources.length, 1);
  });

  it('pauses on the creator\'s cue', async () => {
    const { room, out, hostNow, measure, download, cue } = joiner();
    await measure();
    await download();
    cue({ type: 'play', startAt: hostNow(), fromSeconds: 0 });

    cue({ type: 'pause', pauseAt: hostNow() + START_LEAD_MS });

    assert.equal(out.sources[0]!.stopped, START_LEAD_MS / 1000);
    assert.equal(room.snapshot().playing, false);
  });

  it('cannot cue the room itself', async () => {
    const { room, out, near, measure, download } = joiner();
    await measure();
    await download();
    const before = near.sent.length;

    room.play();
    room.pause();

    assert.equal(out.sources.length, 0);
    assert.equal(near.messages().slice(before).filter((m) => m.type === 'play').length, 0);
  });

  it('says why the room ended, stops the audio, and lets go of its peers', async () => {
    const { room, signaling, mesh, out, hostNow, measure, download, cue } = joiner();
    await measure();
    await download();
    cue({ type: 'play', startAt: hostNow(), fromSeconds: 0 });

    signaling.deliver({ type: 'room-closed', code: 'ABC234', reason: 'creator-left' });

    assert.equal(room.snapshot().ended, 'creator-left');
    assert.equal(room.snapshot().playing, false);
    assert.notEqual(out.sources[0]!.stopped, undefined, 'the track must not play on alone');
    assert.equal(mesh.closed, true);
  });

  it('keeps the first reason when the server hangs up after saying why', () => {
    // An excluded peer is told, then disconnected. The disconnect must not
    // rewrite "started without you" into "check your network".
    const { room, signaling } = joiner();
    signaling.deliver({ type: 'room-closed', code: 'ABC234', reason: 'excluded' });
    signaling.drop();
    assert.equal(room.snapshot().ended, 'excluded');
  });

  it('calls a dropped socket what it is, not the host leaving', () => {
    const { room, signaling } = joiner();
    signaling.drop();
    assert.equal(room.snapshot().ended, 'lost-connection');
  });

  it('ignores a cue and a roster that arrive after the room ended', async () => {
    const { room, signaling, mesh, out, hostNow, measure, download, cue } = joiner();
    await measure();
    await download();
    signaling.drop();
    const synced = mesh.synced.length;

    cue({ type: 'play', startAt: hostNow(), fromSeconds: 0 });
    signaling.deliver(roster([HOST, GUEST, THIRD]));

    assert.equal(out.sources.length, 0);
    assert.equal(mesh.synced.length, synced);
    assert.equal(room.snapshot().peers.length, 2, 'the last roster it was really in');
  });
});

describe('the creator', () => {
  function creator(others: string[] = [GUEST]) {
    const ctx = setup(HOST, [HOST]);
    const wires = new Map(others.map((id) => [id, ctx.mesh.wire(id)]));
    if (others.length > 0) ctx.signaling.deliver(roster([HOST, ...others]));
    const cues = (id: string) =>
      wires.get(id)!.near.messages().filter((m) => m.type === 'play' || m.type === 'pause');
    return { ...ctx, wires, cues, lock: (ids = [HOST, ...others]) => ctx.signaling.deliver(roster(ids, true)) };
  }

  it('has its track from the start, and nobody to wait for', () => {
    const { room } = creator([]);
    assert.deepEqual(room.snapshot().track, { fileName: 'track.mp3', durationSeconds: 60 });
    assert.equal(room.snapshot().isCreator, true);
    assert.equal(room.snapshot().transfers.size, 0);
  });

  it('follows the roster with its mesh, every time', () => {
    const { mesh, signaling } = creator();
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST, THIRD]);
  });

  it('sends the file to a peer who joins, and shows how far along they are', async () => {
    const { room, wires } = creator();
    assert.equal(room.snapshot().transfers.get(GUEST)?.state, 'downloading');
    await settle();

    assert.equal(room.snapshot().transfers.get(GUEST)?.state, 'sent');
    assert.ok(wires.get(GUEST)!.near.sent.some((data) => typeof data !== 'string'), 'bytes went out');
  });

  it('does not restart a transfer when the roster changes under it', async () => {
    // The roster changes on every join. A second header down the same
    // channel is two files interleaved into one buffer.
    const { signaling, wires } = creator();
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    signaling.deliver(roster([HOST, GUEST]));
    await settle();

    const headers = wires.get(GUEST)!.near.messages().filter((m) => m.type === 'file-header');
    assert.equal(headers.length, 1);
  });

  it('answers each peer\'s clock pings', () => {
    const { wires } = creator();
    const { near } = wires.get(GUEST)!;
    near.deliver(JSON.stringify({ type: 'clock-ping', id: 3, t0: 5 }));
    const pong = near.messages().find((m) => m.type === 'clock-pong');
    assert.equal(pong?.id, 3);
    assert.equal(pong?.t1, 1_000, 'on its own clock, which is the reference');
  });

  it('asks the server to start, and plays nothing until the lock comes back', () => {
    const { room, signaling, out, cues } = creator();
    room.start(true);

    assert.deepEqual(signaling.sent, [{ type: 'start-playback', force: true }]);
    assert.equal(out.sources.length, 0);
    assert.deepEqual(cues(GUEST), []);
  });

  it('cues every peer and itself off one instant when the room locks', () => {
    const { room, out, clock, cues, lock } = creator([GUEST, THIRD]);
    lock();

    const cue = { type: 'play', startAt: clock.now() + START_LEAD_MS, fromSeconds: 0 };
    assert.deepEqual(cues(GUEST), [cue]);
    assert.deepEqual(cues(THIRD), [cue]);
    // The same cue, applied at offset zero: one path, not a creator path.
    assert.deepEqual(out.sources[0]!.started, { when: START_LEAD_MS / 1000, offset: 0 });
    assert.equal(room.snapshot().playing, true);
  });

  it('cues once, however the roster changes after the lock', () => {
    // An excluded peer leaving is a roster change. Recueing then would
    // restart the track from the top for everyone still listening.
    const { out, cues, lock } = creator([GUEST, THIRD]);
    lock();
    lock([HOST, GUEST]);

    assert.equal(cues(GUEST).length, 1);
    assert.equal(out.sources.length, 1);
  });

  it('does not cue a peer the lock left behind', () => {
    const { cues, lock } = creator([GUEST, THIRD]);
    lock([HOST, GUEST]);
    assert.equal(cues(THIRD).length, 0);
  });

  it('still starts the room when one peer cannot be reached', () => {
    const { out, wires, cues, lock } = creator([GUEST, THIRD]);
    wires.get(THIRD)!.near.close();
    lock();

    assert.equal(cues(GUEST).length, 1);
    assert.equal(out.sources.length, 1);
  });

  it('pauses everyone on one instant, and resumes from where it stopped', () => {
    const { room, out, clock, cues, lock } = creator();
    lock();
    // Ten seconds in, on both clocks.
    clock.advance(10_000 + START_LEAD_MS);
    out.currentTime = 10 + START_LEAD_MS / 1000;

    room.pause();
    assert.deepEqual(cues(GUEST).at(-1), { type: 'pause', pauseAt: clock.now() + START_LEAD_MS });
    assert.equal(room.snapshot().playing, false);
    assert.equal(room.position(), 10 + START_LEAD_MS / 1000, 'where the pause will land');

    room.play();
    assert.deepEqual(cues(GUEST).at(-1), {
      type: 'play',
      startAt: clock.now() + START_LEAD_MS,
      fromSeconds: 10 + START_LEAD_MS / 1000,
    });
    assert.equal(room.snapshot().playing, true);
  });

  it('cannot play before the room is locked', () => {
    const { room, out, cues } = creator();
    room.play();
    assert.equal(out.sources.length, 0);
    assert.deepEqual(cues(GUEST), []);
  });

  it('passes the listener\'s own offset on to what is playing', () => {
    const { room, out, lock } = creator();
    lock();
    room.setUserOffset(-200);
    assert.equal(out.sources.length, 2, 'heard now, not at the next cue');
  });
});

describe('the snapshot', () => {
  it('is the same object until something changes, and a new one when it does', () => {
    // useSyncExternalStore compares by identity: a fresh object per read is
    // an infinite render, and a mutated one is a change nobody sees.
    const { room, signaling } = setup(HOST, [HOST]);
    const before = room.snapshot();
    assert.equal(room.snapshot(), before);

    let notified = 0;
    room.subscribe(() => notified++);
    signaling.deliver(roster([HOST, GUEST]));

    assert.ok(notified > 0);
    assert.notEqual(room.snapshot(), before);
    assert.equal(before.peers.length, 1, 'the old one is left as it was');
    assert.equal(room.snapshot().peers.length, 2);
  });

  it('goes quiet, hangs up and lets go of the audio once the room is left', () => {
    const { room, signaling, mesh, out } = setup(HOST, [HOST]);
    let notified = 0;
    room.subscribe(() => notified++);

    room.close();
    signaling.deliver(roster([HOST, GUEST]));

    assert.equal(notified, 0);
    assert.equal(signaling.closed, true);
    assert.equal(mesh.closed, true);
    assert.equal(out.closed, true);
  });
});
