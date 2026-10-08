import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, getRoom, setRoom } from './session.ts';
import { FakeChannel } from './testing.ts';

/**
 * Entering a room: audio is armed on the tap, the handshake names us, and
 * the room that comes out is the one this tab is in. Web Audio, WebSocket
 * and WebRTC do not
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
  it('asks for an empty room, with its description and passcode, and enters it as creator', async () => {
    const pending = createRoom({
      roomName: 'Kitchen',
      description: 'Friday',
      displayName: 'Keyur',
      passcode: 'hunter2',
    });
    await flush();

    const socket = sockets[0];
    assert.ok(socket, 'expected a socket once audio was armed');
    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'create-room',
      roomName: 'Kitchen',
      description: 'Friday',
      displayName: 'Keyur',
      passcode: 'hunter2',
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
      description: 'Friday',
      peers: [
        { peerId: OTHER, displayName: 'Someone else', isCreator: false },
        { peerId: CREATOR, displayName: 'Keyur', isCreator: true },
      ],
    });

    const room = await pending;
    // Identity comes from room-created, not from roster position.
    assert.equal(room.snapshot().selfPeerId, CREATOR);
    assert.equal(room.snapshot().isCreator, true);
    assert.equal(room.snapshot().code, 'RW53NG');
    // A room starts with nothing in it: tracks are added from inside.
    assert.deepEqual(room.snapshot().playlist, []);
    // Kept on this device so the share link can carry it.
    assert.equal(room.snapshot().passcode, 'hunter2');
    assert.equal(getRoom(), room);
  });

  it('rejects and closes everything when the server refuses', async () => {
    const pending = createRoom({ roomName: 'Kitchen', displayName: 'Keyur' });
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
      description: '',
      peers: [
        { peerId: CREATOR, displayName: 'Keyur', isCreator: true },
        { peerId: OTHER, displayName: 'Sam', isCreator: false },
      ],
    });

    const room = await promise;
    assert.equal(room.snapshot().selfPeerId, OTHER);
    assert.equal(room.snapshot().isCreator, false);
    // Nothing to play yet; the playlist comes from the creator.
    assert.deepEqual(room.snapshot().playlist, []);
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
      description: '',
      peers: [{ peerId: OTHER, displayName: 'Sam', isCreator: false }],
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
