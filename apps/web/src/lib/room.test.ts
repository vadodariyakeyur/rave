import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, Peer, RoomState, ServerMessage } from '@rave/protocol';
import { DECODE_ERROR } from './audio.ts';
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
 * happens between them — a cue that beats the track it starts, someone
 * arriving mid-track, the room moving to another track while one decodes, a
 * room that ends twice. Faked here: the server socket, the peers' channels,
 * the audio device and the clock. Everything in between is the real thing.
 */

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

const peer = (peerId: string): Peer => ({
  peerId,
  displayName: peerId.slice(0, 4),
  isCreator: peerId === HOST,
});

const roster = (peerIds: string[], mode: RoomState['mode'] = 'music'): RoomState => ({
  type: 'room-state',
  code: 'ABC234',
  roomName: 'Kitchen',
  description: 'Friday',
  mode,
  peers: peerIds.map(peer),
});

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
  readonly localAudio: (MediaStreamTrack | null)[] = [];
  setLocalAudio(track: MediaStreamTrack | null): void {
    this.localAudio.push(track);
  }
  onRemoteAudio(): () => void {
    return () => {};
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

interface FakeSource {
  started?: { when: number; offset: number };
  stopped?: number;
  onended: (() => void) | null;
}

/** An audio device that records what was scheduled on it. */
function audio() {
  const sources: FakeSource[] = [];
  const self = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    sources,
    closed: false,
    /** Lengths, by how many bytes the encoded file had. Missing means it will not decode. */
    durations: new Map<number, number>(),
    createAnalyser() {
      return { fftSize: 0, smoothingTimeConstant: 0, connect() {}, disconnect() {}, getByteFrequencyData() {} };
    },
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
    async decodeAudioData(encoded: ArrayBuffer) {
      const duration = self.durations.get(encoded.byteLength);
      if (duration === undefined) throw new Error('cannot decode');
      return { duration } as AudioBuffer;
    },
    async close() {
      self.closed = true;
    },
  };
  return self;
}

const noTimers: Every = () => () => {};

/** Long enough for transfers and decodes to run through. */
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Two tracks told apart by size, which is also how the fake decoder knows their length. */
const A = { title: 'a.mp3', byteLength: 40_000, duration: 60 };
const B = { title: 'b.mp3', byteLength: 20_000, duration: 120 };
const file = (track: { title: string; byteLength: number }) =>
  ({ name: track.title, arrayBuffer: async () => bytes(track.byteLength) }) as unknown as File;

function setup(
  self: string,
  peerIds: string[],
  passcode?: string,
  readArt: RoomDeps['readArt'] = async () => undefined,
) {
  const signaling = new FakeSignaling();
  const mesh = new RoomMesh();
  const out = audio();
  out.durations.set(A.byteLength, A.duration).set(B.byteLength, B.duration);
  const clock = virtualClock(1_000);
  let minted = 0;
  const deps: RoomDeps = { createMesh: () => mesh, clock, every: noTimers, id: () => `t${++minted}`, readArt };
  const room = new LiveRoom(
    {
      signaling,
      audioContext: out as never,
      entered: { peerId: self, iceServers: [], state: roster(peerIds) },
      passcode,
    },
    deps,
  );
  return { signaling, mesh, out, clock, room };
}

describe('the creator', () => {
  async function creator(others: string[] = [GUEST]) {
    const ctx = setup(HOST, [HOST]);
    const wires = new Map(others.map((id) => [id, ctx.mesh.wire(id)]));
    if (others.length > 0) ctx.signaling.deliver(roster([HOST, ...others]));
    await settle();
    const heard = (id: string, ...types: string[]) =>
      wires.get(id)!.near.messages().filter((m) => types.includes(m.type as string));
    return { ...ctx, wires, heard, cues: (id: string) => heard(id, 'select', 'play', 'pause', 'stop') };
  }

  it('starts with an empty room: no tracks, nothing playing, nothing to send', async () => {
    const { room } = await creator();
    const snapshot = room.snapshot();
    assert.deepEqual(snapshot.playlist, []);
    assert.equal(snapshot.currentTrackId, undefined);
    assert.equal(snapshot.playing, false);
    assert.equal(snapshot.transfers.size, 0);
    assert.equal(snapshot.description, 'Friday');
  });

  it('adds tracks at any time: members hear the playlist and are sent the files', async () => {
    const { room, heard } = await creator();
    await room.addTracks([file(A), file(B)]);
    await settle();

    assert.deepEqual(
      room.snapshot().playlist.map((t) => [t.id, t.title, t.state]),
      [['t1', 'a.mp3', 'ready'], ['t2', 'b.mp3', 'ready']],
    );
    assert.deepEqual(heard(GUEST, 'playlist').at(-1)?.tracks, [
      { id: 't1', title: 'a.mp3', byteLength: A.byteLength },
      { id: 't2', title: 'b.mp3', byteLength: B.byteLength },
    ]);
    assert.deepEqual(heard(GUEST, 'file-header').map((h) => h.trackId), ['t1', 't2']);
    assert.equal(room.snapshot().transfers.get(GUEST)?.state, 'sent');
  });

  it('never lets an undecodable file reach a member, and still adds the good ones', async () => {
    const { room, heard } = await creator();
    const broken = { title: 'broken.bin', byteLength: 123 };

    await assert.rejects(room.addTracks([file(broken), file(A)]), { message: DECODE_ERROR });
    await settle();

    assert.deepEqual(room.snapshot().playlist.map((t) => t.title), ['a.mp3']);
    assert.equal(heard(GUEST, 'file-header').length, 1);
  });

  it('plays a track: everyone is told which, then cued off one instant', async () => {
    const { room, out, clock, cues, signaling } = await creator([GUEST, THIRD]);
    await room.addTracks([file(A)]);
    await room.playTrack('t1');

    const expected = [
      { type: 'select', trackId: 't1' },
      { type: 'play', trackId: 't1', startAt: clock.now() + START_LEAD_MS, fromSeconds: 0 },
    ];
    assert.deepEqual(cues(GUEST), expected);
    assert.deepEqual(cues(THIRD), expected);
    // The same cue, applied at offset zero: one path, not a creator path.
    assert.deepEqual(out.sources[0]!.started, { when: START_LEAD_MS / 1000, offset: 0 });
    assert.equal(room.snapshot().playing, true);
    assert.equal(room.snapshot().currentTrackId, 't1');
    assert.equal(room.snapshot().currentDuration, A.duration);
    assert.deepEqual(signaling.sent.at(-1), { type: 'now-playing', title: 'a.mp3' });
  });

  it('can play while alone in the room', async () => {
    const { room, out } = await creator([]);
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    assert.equal(out.sources.length, 1);
  });

  it('pauses everyone on one instant, and resumes from where it stopped', async () => {
    const { room, out, clock, cues, signaling } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    // Ten seconds in, on both clocks.
    clock.advance(10_000 + START_LEAD_MS);
    out.currentTime = 10 + START_LEAD_MS / 1000;

    room.pause();
    assert.deepEqual(cues(GUEST).at(-1), { type: 'pause', pauseAt: clock.now() + START_LEAD_MS });
    assert.equal(room.snapshot().playing, false);
    assert.deepEqual(signaling.sent.at(-1), { type: 'now-playing', title: null });

    room.resume();
    assert.deepEqual(cues(GUEST).at(-1), {
      type: 'play',
      trackId: 't1',
      startAt: clock.now() + START_LEAD_MS,
      fromSeconds: 10 + START_LEAD_MS / 1000,
    });
    assert.equal(room.snapshot().playing, true);
  });

  it('restarts the current track from the top', async () => {
    const { room, out, clock, cues } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    clock.advance(10_000);
    out.currentTime = 10;

    room.restart();
    await settle();

    assert.equal(cues(GUEST).at(-1)?.fromSeconds, 0);
    assert.equal(out.sources.at(-1)!.started?.offset, 0);
  });

  it('stops: silence everywhere, back at the start, the track still chosen', async () => {
    const { room, out, clock, cues } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    clock.advance(10_000);
    out.currentTime = 10;

    room.stop();

    assert.deepEqual(cues(GUEST).at(-1), { type: 'stop' });
    assert.notEqual(out.sources[0]!.stopped, undefined);
    assert.equal(room.snapshot().playing, false);
    assert.equal(room.position(), 0);
    assert.equal(room.snapshot().currentTrackId, 't1');
  });

  it('moves to another track: the first goes quiet, the second plays from the top', async () => {
    const { room, out, cues } = await creator();
    await room.addTracks([file(A), file(B)]);
    await room.playTrack('t1');
    await room.playTrack('t2');

    assert.notEqual(out.sources[0]!.stopped, undefined);
    assert.equal(out.sources[1]!.started?.offset, 0);
    assert.equal(room.snapshot().currentTrackId, 't2');
    assert.equal(room.snapshot().currentDuration, B.duration);
    assert.deepEqual(cues(GUEST).map((c) => [c.type, c.trackId]).slice(-2), [
      ['select', 't2'],
      ['play', 't2'],
    ]);
  });

  it('plays only the last track picked when two are picked in a hurry', async () => {
    const { room, out, cues } = await creator();
    await room.addTracks([file(A), file(B)]);
    void room.playTrack('t1');
    await room.playTrack('t2');
    await settle();

    assert.deepEqual(cues(GUEST).filter((c) => c.type === 'play').map((c) => c.trackId), ['t2']);
    assert.equal(out.sources.length, 1);
  });

  it('reorders the playlist, and everyone hears the new order', async () => {
    const { room, heard } = await creator();
    await room.addTracks([file(A), file(B)]);

    room.moveTrack('t2', -1);
    assert.deepEqual(room.snapshot().playlist.map((t) => t.id), ['t2', 't1']);
    assert.deepEqual(
      (heard(GUEST, 'playlist').at(-1)?.tracks as { id: string }[]).map((t) => t.id),
      ['t2', 't1'],
    );

    room.moveTrack('t2', -1);
    assert.deepEqual(room.snapshot().playlist.map((t) => t.id), ['t2', 't1'], 'already first');
  });

  it('removes a track, stopping it first if it is the one playing', async () => {
    const { room, out, cues, heard } = await creator();
    await room.addTracks([file(A), file(B)]);
    await room.playTrack('t1');

    room.removeTrack('t1');

    assert.deepEqual(cues(GUEST).at(-1), { type: 'stop' });
    assert.notEqual(out.sources[0]!.stopped, undefined);
    assert.deepEqual(room.snapshot().playlist.map((t) => t.id), ['t2']);
    assert.equal(room.snapshot().currentTrackId, undefined);
    assert.equal((heard(GUEST, 'playlist').at(-1)?.tracks as unknown[]).length, 1);
  });

  it('tells someone who arrives mid-track where the room is, with the original cue', async () => {
    // The instant in that cue is in the past by the time they hear it, which
    // is exactly what makes their device start part-way through, in sync.
    const { room, mesh, signaling, clock } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    const startAt = clock.now() + START_LEAD_MS;
    clock.advance(20_000);

    const late = mesh.wire(THIRD);
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    await settle();

    const heard = late.near.messages();
    assert.deepEqual(
      heard.filter((m) => m.type !== 'file-header').map((m) => m.type),
      ['playlist', 'select', 'play'],
    );
    assert.equal(heard.find((m) => m.type === 'play')?.startAt, startAt);
    assert.deepEqual(heard.filter((m) => m.type === 'file-header').map((m) => m.trackId), ['t1']);
  });

  it('does not hand a newcomer the cue for a track that has already run out', async () => {
    const { room, mesh, signaling, out } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    out.sources[0]!.onended?.();
    assert.deepEqual(signaling.sent.at(-1), { type: 'now-playing', title: null });

    const late = mesh.wire(THIRD);
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    await settle();

    assert.equal(late.near.messages().some((m) => m.type === 'play'), false);
  });

  it('does not restart a transfer when the roster changes under it', async () => {
    const { room, signaling, heard } = await creator();
    await room.addTracks([file(A)]);
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    signaling.deliver(roster([HOST, GUEST]));
    await settle();

    assert.equal(heard(GUEST, 'file-header').length, 1);
  });

  it('connects to every member, and answers each one\'s clock pings', async () => {
    const { mesh, signaling, wires } = await creator();
    signaling.deliver(roster([HOST, GUEST, THIRD]));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST, THIRD]);

    const { near } = wires.get(GUEST)!;
    near.deliver(JSON.stringify({ type: 'clock-ping', id: 3, t0: 5 }));
    const pong = near.messages().find((m) => m.type === 'clock-pong');
    assert.equal(pong?.id, 3);
    assert.equal(pong?.t1, 1_000, 'on its own clock, which is the reference');
  });

  it('switches to talk by stopping the music for everyone and then telling the server', async () => {
    const { room, signaling, wires } = await creator();
    room.setMode('talk');
    assert.deepEqual(signaling.sent.at(-1), { type: 'set-mode', mode: 'talk' });
    const { near } = wires.get(GUEST)!;
    assert.equal(near.messages().some((m) => m.type === 'stop'), true, 'the room goes quiet first');

    // The server's word is what changes the mode, not our asking.
    assert.equal(room.snapshot().mode, 'music');
    signaling.deliver(roster([HOST, GUEST], 'talk'));
    assert.equal(room.snapshot().mode, 'talk');
  });

  it('asks for nothing when the room is already in that mode', async () => {
    const { room, signaling } = await creator();
    room.setMode('music');
    assert.deepEqual(signaling.sent, []);
  });

  it('connects to every member in music and in talk', async () => {
    const { mesh, signaling } = await creator([GUEST, THIRD]);
    signaling.deliver(roster([HOST, GUEST, THIRD], 'talk'));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST, THIRD]);
  });

  it('asks the server to remove a member', async () => {
    const { room, signaling } = await creator();
    room.kick(GUEST);
    assert.deepEqual(signaling.sent.at(-1), { type: 'kick', peerId: GUEST });
  });

  it('passes the listener\'s own offset on to what is playing', async () => {
    const { room, out } = await creator();
    await room.addTracks([file(A)]);
    await room.playTrack('t1');
    room.setUserOffset(-200);
    assert.equal(out.sources.length, 2, 'heard now, not at the next cue');
  });
});

describe('pictures and reactions', () => {
  it('gives a track the picture read from its file, and lets go of it when the track goes', async () => {
    const revoke = mock.method(URL, 'revokeObjectURL', () => {});
    try {
      const { room } = setup(HOST, [HOST], undefined, async () => ({ url: 'blob:cover' }));
      await room.addTracks([file(A)]);
      await settle();
      assert.equal(room.snapshot().playlist[0]?.art?.url, 'blob:cover');

      room.removeTrack('t1');
      assert.deepEqual(revoke.mock.calls.map((c) => c.arguments[0]), ['blob:cover']);
      assert.equal(room.snapshot().playlist.length, 0);
    } finally {
      revoke.mock.restore();
    }
  });

  it('leaves a track with no picture as it is', async () => {
    const { room } = setup(HOST, [HOST]);
    await room.addTracks([file(A)]);
    await settle();
    assert.equal(room.snapshot().playlist[0]?.art, undefined);
  });

  it('throws away a picture that finishes after its track was removed', async () => {
    const revoke = mock.method(URL, 'revokeObjectURL', () => {});
    try {
      let finish!: (art: { url: string }) => void;
      const { room } = setup(HOST, [HOST], undefined, () => new Promise((resolve) => (finish = resolve)));
      await room.addTracks([file(A)]);
      room.removeTrack('t1');
      finish({ url: 'blob:late' });
      await settle();
      assert.deepEqual(revoke.mock.calls.map((c) => c.arguments[0]), ['blob:late']);
      assert.equal(room.snapshot().playlist.length, 0);
    } finally {
      revoke.mock.restore();
    }
  });

  it('sends a reaction to the server and shows it here at once', () => {
    const { room, signaling } = setup(HOST, [HOST, GUEST]);
    const seen: { from: string; reaction: string }[] = [];
    room.onReaction((e) => seen.push(e));
    room.react('fire');
    assert.deepEqual(signaling.sent.at(-1), { type: 'react', reaction: 'fire' });
    assert.deepEqual(seen, [{ from: HOST, reaction: 'fire' }]);
  });

  it('shows what others send, until the listener lets go or the room ends', () => {
    const { room, signaling } = setup(GUEST, [HOST, GUEST]);
    const seen: string[] = [];
    const stop = room.onReaction((e) => seen.push(`${e.from.slice(0, 1)}:${e.reaction}`));
    signaling.deliver({ type: 'reaction', from: HOST, reaction: 'heart' });
    stop();
    signaling.deliver({ type: 'reaction', from: HOST, reaction: 'laugh' });
    assert.deepEqual(seen, ['1:heart']);

    room.onReaction((e) => seen.push(e.reaction));
    signaling.deliver({ type: 'room-closed', code: 'ABC234', reason: 'creator-left' });
    signaling.deliver({ type: 'reaction', from: HOST, reaction: 'party' });
    assert.equal(seen.includes('party'), false);
    room.react('fire');
    assert.equal(signaling.sent.some((m) => m.type === 'react'), false, 'nothing sent into a dead room');
  });
});

describe('a member in talk mode', () => {
  it('stays linked to the creator alone in music, and to everyone once the room is talking', () => {
    const { mesh, signaling, room } = setup(GUEST, [HOST, GUEST, THIRD]);
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST]);

    signaling.deliver(roster([HOST, GUEST, THIRD], 'talk'));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST, THIRD]);
    assert.equal(room.snapshot().mode, 'talk');

    signaling.deliver(roster([HOST, GUEST, THIRD], 'music'));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST], 'back to the creator alone');
  });

  it('cannot switch the room', () => {
    const { room, signaling } = setup(GUEST, [HOST, GUEST]);
    room.setMode('talk');
    assert.deepEqual(signaling.sent, []);
  });

  it('only asks for the microphone while the room is talking', async () => {
    const { room, signaling } = setup(GUEST, [HOST, GUEST]);
    await room.enableMic();
    assert.equal(room.snapshot().voice.micOn, false);
    assert.equal(room.snapshot().voice.error, undefined, 'music mode never even asked');
    signaling.deliver(roster([HOST, GUEST], 'talk'));
  });
});

describe('a member', () => {
  /** How far ahead of ours the creator's clock runs. */
  const AHEAD = 40_000;

  function member() {
    const ctx = setup(GUEST, [HOST, GUEST, THIRD]);
    const { near, far } = ctx.mesh.wire(HOST);
    // The creator's device: answers clock pings on its own clock.
    const host = new ChannelLink();
    host.attach(far);
    const hostNow = () => ctx.clock.now() + AHEAD;
    serveClock(host, hostNow);
    const say = (msg: object) => near.deliver(JSON.stringify(msg));
    return {
      ...ctx,
      near,
      hostNow,
      say,
      /** One full probe round. */
      measure: () => step(ctx.clock, 1_500),
      playlist: (...tracks: { title: string; byteLength: number }[]) =>
        say({
          type: 'playlist',
          tracks: tracks.map((t) => ({ id: t.title, title: t.title, byteLength: t.byteLength })),
        }),
      /** A track's file arrives from the creator. Its id is its title. */
      download: async (track: { title: string; byteLength: number }) => {
        await settle();
        await send(far, { trackId: track.title, bytes: bytes(track.byteLength), fileName: track.title });
        await settle();
      },
    };
  }

  it('connects to the creator and nobody else', () => {
    // Everything a member needs comes from the creator. A link to every
    // other member would grow with the square of the room for nothing.
    const { mesh, signaling } = member();
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST]);
    signaling.deliver(roster([HOST, GUEST, THIRD, '44444444-4444-4444-8444-444444444444']));
    assert.deepEqual(mesh.synced.at(-1), [HOST, GUEST]);
    assert.equal(mesh.synced.length > 0, true);
  });

  it('shows the playlist as it stands on this device: waiting, then ready', async () => {
    const { room, playlist, download } = member();
    playlist(A, B);
    assert.deepEqual(room.snapshot().playlist.map((t) => [t.title, t.state]), [
      ['a.mp3', 'waiting'],
      ['b.mp3', 'waiting'],
    ]);

    await download(A);
    assert.deepEqual(room.snapshot().playlist.map((t) => t.state), ['ready', 'waiting']);
  });

  it('measures its clock against the creator and shows the estimate', async () => {
    const { room, measure } = member();
    assert.equal(room.snapshot().estimate, undefined);
    await measure();
    assert.equal(room.snapshot().estimate?.offsetMs, AHEAD);
  });

  it('gets a track ready when told which is next, and starts on the cue', async () => {
    const { room, out, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A);
    await download(A);

    say({ type: 'select', trackId: 'a.mp3' });
    await settle();
    assert.equal(room.snapshot().currentTrackId, 'a.mp3');
    assert.equal(room.snapshot().currentDuration, A.duration, 'decoded and waiting');
    assert.equal(out.sources.length, 0, 'but nothing plays until cued');

    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow() + START_LEAD_MS, fromSeconds: 0 });
    assert.deepEqual(out.sources[0]!.started, { when: START_LEAD_MS / 1000, offset: 0 });
    assert.equal(room.snapshot().playing, true);
  });

  it('joins a track already playing, from where the room has got to', async () => {
    // Arriving mid-track: the cue is old, the file is not here yet. Once it
    // lands and decodes, this device comes in part-way through, in sync.
    const { room, out, clock, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A);
    say({ type: 'select', trackId: 'a.mp3' });
    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow() - 20_000, fromSeconds: 0 });
    assert.equal(out.sources.length, 0, 'nothing to play yet');

    clock.advance(2_000);
    await download(A);

    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0]!.started?.offset, 22, 'twenty-two seconds in, with everyone else');
    assert.equal(room.snapshot().playing, true);
  });

  it('holds a cue that beat the first clock measurement, instead of guessing', async () => {
    const { out, hostNow, measure, playlist, download, say } = member();
    playlist(A);
    await download(A);

    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow() + START_LEAD_MS, fromSeconds: 0 });
    await settle();
    assert.equal(out.sources.length, 0);

    await measure();
    assert.equal(out.sources.length, 1);
  });

  it('follows the room to another track: quiet at once, then the new one', async () => {
    const { room, out, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A, B);
    await download(A);
    await download(B);
    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow(), fromSeconds: 0 });
    await settle();
    assert.equal(room.snapshot().playing, true);

    say({ type: 'select', trackId: 'b.mp3' });
    say({ type: 'play', trackId: 'b.mp3', startAt: hostNow() + START_LEAD_MS, fromSeconds: 0 });
    assert.notEqual(out.sources[0]!.stopped, undefined, 'the old track does not play on');
    await settle();

    assert.equal(out.sources.length, 2);
    assert.equal(room.snapshot().currentTrackId, 'b.mp3');
    assert.equal(room.snapshot().currentDuration, B.duration);
    assert.equal(room.snapshot().playing, true);
  });

  it('pauses and stops on the creator\'s cue', async () => {
    const { room, out, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A);
    await download(A);
    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow(), fromSeconds: 0 });
    await settle();

    say({ type: 'pause', pauseAt: hostNow() + START_LEAD_MS });
    assert.equal(out.sources[0]!.stopped, START_LEAD_MS / 1000);
    assert.equal(room.snapshot().playing, false);

    say({ type: 'stop' });
    assert.equal(room.position(), 0);
  });

  it('sits out a track its browser cannot decode, without taking the room down', async () => {
    const { room, out, hostNow, measure, playlist, download, say } = member();
    const odd = { title: 'odd.ogg', byteLength: 777 };
    await measure();
    playlist(odd);
    await download(odd);

    say({ type: 'play', trackId: 'odd.ogg', startAt: hostNow(), fromSeconds: 0 });
    await settle();

    assert.equal(out.sources.length, 0);
    assert.equal(room.snapshot().playing, false);
    assert.equal(room.snapshot().ended, undefined);
  });

  it('lets go of a track the creator removed', async () => {
    const { room, playlist, download } = member();
    playlist(A, B);
    await download(A);
    playlist(B);
    assert.deepEqual(room.snapshot().playlist.map((t) => t.title), ['b.mp3']);

    // Back in the list under the same id, it has to be fetched again.
    playlist(A, B);
    assert.equal(room.snapshot().playlist[0]?.state, 'waiting');
  });

  it('cannot run the room itself', async () => {
    const { room, out, signaling, near, measure, playlist, download } = member();
    await measure();
    playlist(A);
    await download(A);
    const before = near.sent.length;

    await room.addTracks([file(B)]);
    await room.playTrack('a.mp3');
    room.pause();
    room.stop();
    room.kick(THIRD);

    assert.equal(out.sources.length, 0);
    assert.equal(near.messages().slice(before).some((m) => m.type !== 'clock-ping'), false);
    assert.deepEqual(signaling.sent, []);
  });

  it('says why the room ended, stops the audio, and lets go of its peers', async () => {
    const { room, signaling, mesh, out, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A);
    await download(A);
    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow(), fromSeconds: 0 });
    await settle();

    signaling.deliver({ type: 'room-closed', code: 'ABC234', reason: 'creator-left' });

    assert.equal(room.snapshot().ended, 'creator-left');
    assert.equal(room.snapshot().playing, false);
    assert.notEqual(out.sources[0]!.stopped, undefined, 'the track must not play on alone');
    assert.equal(mesh.closed, true);
  });

  it('keeps the first reason when the server hangs up after saying why', () => {
    // A kicked member is told, then disconnected. The disconnect must not
    // rewrite "you were removed" into "check your network".
    const { room, signaling } = member();
    signaling.deliver({ type: 'room-closed', code: 'ABC234', reason: 'kicked' });
    signaling.drop();
    assert.equal(room.snapshot().ended, 'kicked');
  });

  it('calls a dropped socket what it is, not the host leaving', () => {
    const { room, signaling } = member();
    signaling.drop();
    assert.equal(room.snapshot().ended, 'lost-connection');
  });

  it('ignores a cue and a roster that arrive after the room ended', async () => {
    const { room, signaling, mesh, out, hostNow, measure, playlist, download, say } = member();
    await measure();
    playlist(A);
    await download(A);
    signaling.drop();
    const synced = mesh.synced.length;

    say({ type: 'play', trackId: 'a.mp3', startAt: hostNow(), fromSeconds: 0 });
    signaling.deliver(roster([HOST, GUEST]));
    await settle();

    assert.equal(out.sources.length, 0);
    assert.equal(mesh.synced.length, synced);
    assert.equal(room.snapshot().peers.length, 3, 'the last roster it was really in');
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

  it('carries the passcode this device got in with, for the share link', () => {
    assert.equal(setup(HOST, [HOST], 'hunter2').room.snapshot().passcode, 'hunter2');
    assert.equal(setup(HOST, [HOST]).room.snapshot().passcode, undefined);
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
