import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, getRoom, setRoom } from './session.ts';
import { FakeChannel } from './testing.ts';

/**
 * The invariant this ticket exists for: a file that cannot be decoded must
 * never produce a room, because a room code issued for unplayable audio
 * strands everyone who joins it. Web Audio, WebSocket and WebRTC do not
 * exist in Node, so each is stubbed at the global the code actually reaches
 * for.
 */

// Real uuids: the protocol schema rejects anything else, so a readable
// placeholder would fail parsing rather than the assertion under test.
const CREATOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const sockets: FakeSocket[] = [];
const contexts: FakeContext[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(readonly url: string) {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  deliver(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }
}

class FakeContext {
  state = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  closed = false;
  constructor() {
    contexts.push(this);
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  createBuffer(): unknown {
    return { duration: 0 };
  }
  createBufferSource(): unknown {
    return { buffer: null, connect: () => {}, start: () => {} };
  }
  get destination(): unknown {
    return {};
  }
  async decodeAudioData(): Promise<unknown> {
    return decodeResult();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

let decodeResult: () => unknown;

/**
 * Entering a room starts its mesh, which opens a connection per peer in the
 * roster. Nothing here negotiates; it only has to be constructible.
 */
class FakePeerConnection {
  addEventListener(): void {}
  createDataChannel(): FakeChannel {
    return new FakeChannel('connecting');
  }
  close(): void {}
}

/** Lets the arm + decode + connect chain settle before inspecting the socket. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeFile(name = 'track.mp3'): File {
  return { name, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;
}

const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  sockets.length = 0;
  contexts.length = 0;
  decodeResult = () => ({ duration: 12.5 });
  globals['AudioContext'] = FakeContext;
  globals['WebSocket'] = FakeSocket;
  globals['RTCPeerConnection'] = FakePeerConnection;
  globals['window'] = { location: { host: 'rave.local', protocol: 'https:' } };
  setRoom(undefined);
});

afterEach(() => {
  delete globals['AudioContext'];
  delete globals['WebSocket'];
  delete globals['RTCPeerConnection'];
  delete globals['window'];
  setRoom(undefined);
});

describe('createRoom', () => {
  it('does not open a socket when the file cannot be decoded', async () => {
    decodeResult = () => {
      throw new Error('bad file');
    };

    await assert.rejects(
      createRoom({ roomName: 'Kitchen', displayName: 'Keyur', file: fakeFile('broken.bin') }),
    );

    // The whole point of the decode gate: no socket, so no room, so no code.
    assert.equal(sockets.length, 0);
    assert.equal(getRoom(), undefined);
    assert.equal(contexts[0]?.closed, true);
  });

  it('sends create-room only after a successful decode, and keeps the decoded duration', async () => {
    const pending = createRoom({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      file: fakeFile(),
    });
    await flush();

    const socket = sockets[0];
    assert.ok(socket, 'expected a socket once the decode succeeded');
    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'create-room',
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 12.5,
    });

    socket.deliver({
      type: 'room-created',
      code: 'RW53NG',
      peerId: CREATOR,
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    socket.deliver({
      type: 'room-state',
      code: 'RW53NG',
      roomName: 'Kitchen',
      locked: false,
      peers: [
        { peerId: OTHER, displayName: 'Someone else', isCreator: false, ready: false },
        { peerId: CREATOR, displayName: 'Keyur', isCreator: true, ready: true },
      ],
    });

    const room = await pending;
    // Identity comes from room-created, not from roster position.
    assert.equal(room.snapshot().selfPeerId, CREATOR);
    assert.equal(room.snapshot().isCreator, true);
    assert.equal(room.snapshot().code, 'RW53NG');
    assert.deepEqual(room.snapshot().track, { fileName: 'track.mp3', durationSeconds: 12.5 });
    assert.equal(getRoom(), room);
  });

  it('rejects and closes everything when the server refuses', async () => {
    const pending = createRoom({ roomName: 'Kitchen', displayName: 'Keyur', file: fakeFile() });
    await flush();

    const socket = sockets[0]!;
    socket.deliver({ type: 'error', code: 'invalid-request', message: 'Nope.' });

    await assert.rejects(pending, { message: 'Nope.' });
    assert.equal(getRoom(), undefined);
    assert.equal(socket.readyState, 3);
    assert.equal(contexts[0]?.closed, true);
  });
});

describe('joinRoom', () => {
  it('sends join-room and resolves with our own peer id and no buffer', async () => {
    const promise = joinRoom({ code: 'ABC234', displayName: 'Sam' });
    await flush();

    const socket = sockets[0]!;
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'join-room',
      code: 'ABC234',
      displayName: 'Sam',
    });

    socket.deliver({ type: 'room-joined', code: 'ABC234', peerId: OTHER });
    socket.deliver({
      type: 'room-state',
      code: 'ABC234',
      roomName: 'Kitchen',
      locked: false,
      peers: [
        { peerId: CREATOR, displayName: 'Keyur', isCreator: true, ready: true },
        { peerId: OTHER, displayName: 'Sam', isCreator: false, ready: false },
      ],
    });

    const room = await promise;
    assert.equal(room.snapshot().selfPeerId, OTHER);
    assert.equal(room.snapshot().isCreator, false);
    // The joiner has nothing to play yet; the file comes from the creator.
    assert.equal(room.snapshot().track, undefined);
    assert.equal(getRoom(), room);
  });

  it('rejects an unknown code and leaves no session behind', async () => {
    const promise = joinRoom({ code: 'ZZZZZZ', displayName: 'Sam' });
    await flush();

    sockets[0]!.deliver({
      type: 'error',
      code: 'room-not-found',
      message: 'No room with that code. Check it and try again.',
    });

    await assert.rejects(promise, /No room with that code/);
    assert.equal(getRoom(), undefined);
    assert.equal(contexts[0]!.closed, true);
  });
  it('refuses a malformed code without opening a socket or a context', async () => {
    // A code the schema rejects cannot reach the server at all, so the
    // person must get the room-not-found wording, not a parse failure.
    await assert.rejects(joinRoom({ code: 'ABC', displayName: 'Sam' }), /No room with that code/);
    assert.equal(sockets.length, 0);
    assert.equal(contexts.length, 0);
    assert.equal(getRoom(), undefined);
  });

  it('leaves the room it was in when it enters another', async () => {
    // Otherwise the first socket stays open and the server keeps a peer in
    // a room whose tab has moved on.
    const state = (code: string) => ({
      type: 'room-state',
      code,
      roomName: 'Kitchen',
      locked: false,
      peers: [{ peerId: OTHER, displayName: 'Sam', isCreator: false, ready: false }],
    });
    const first = joinRoom({ code: 'ABC234', displayName: 'Sam' });
    await flush();
    sockets[0]!.deliver({ type: 'room-joined', code: 'ABC234', peerId: OTHER });
    sockets[0]!.deliver(state('ABC234'));
    await first;

    const second = joinRoom({ code: 'DEF567', displayName: 'Sam' });
    await flush();
    sockets[1]!.deliver({ type: 'room-joined', code: 'DEF567', peerId: OTHER });
    sockets[1]!.deliver(state('DEF567'));
    await second;

    assert.equal(sockets[0]!.readyState, 3, 'the first socket was hung up');
    assert.equal(contexts[0]!.closed, true, 'and its audio let go');
    assert.equal(getRoom()?.snapshot().code, 'DEF567');
  });
});
