import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTION_LOST, EnterRefused, Signaling, type SignalingSocket } from './signaling.ts';

/**
 * The handshake that turns a socket into a place in a room. The socket is
 * handed in, so nothing here reaches for a global.
 */

const ME = '11111111-1111-4111-8111-111111111111';

class FakeSocket {
  readyState = 0;
  readonly sent: unknown[] = [];
  readonly #listeners = new Map<string, Set<(ev: unknown) => void>>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.#emit('open');
  }
  drop(): void {
    this.readyState = 3;
    this.#emit('close');
  }
  deliver(msg: unknown): void {
    this.#emit('message', { data: JSON.stringify(msg) });
  }
  listening(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
  #emit(type: string, ev: unknown = {}): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(ev);
  }
}

function connect() {
  const socket = new FakeSocket();
  const signaling = new Signaling(socket as unknown as SignalingSocket);
  return { socket, signaling };
}

const join = { type: 'join-room', code: 'ABC234', displayName: 'Sam' } as const;
const hello = {
  type: 'server-hello',
  protocolVersion: 1,
  serverTime: '2026-09-19T00:00:00.000Z',
  iceServers: [{ urls: 'stun:example:1' }],
};
const roster = {
  type: 'room-state',
  code: 'ABC234',
  roomName: 'Kitchen',
  description: '',
  peers: [{ peerId: ME, displayName: 'Sam', isCreator: false }],
};

describe('Signaling', () => {
  it('holds what is sent until the socket opens', () => {
    const { socket, signaling } = connect();
    signaling.send({ type: 'watch-rooms' });
    assert.deepEqual(socket.sent, []);

    socket.open();
    assert.deepEqual(socket.sent, [{ type: 'watch-rooms' }]);
  });

  it('drops anything that fails the schema', () => {
    const { socket, signaling } = connect();
    const heard: unknown[] = [];
    signaling.onMessage((msg) => heard.push(msg));
    socket.deliver({ type: 'room-state', code: 'nope' });
    assert.deepEqual(heard, []);
  });
});

describe('entering a room', () => {
  it('resolves with who we are, who is here, and how to reach them', async () => {
    const { socket, signaling } = connect();
    socket.open();
    const entering = signaling.enter(join);
    assert.deepEqual(socket.sent, [join]);

    socket.deliver(hello);
    socket.deliver({ type: 'room-joined', code: 'ABC234', peerId: ME });
    socket.deliver(roster);

    const entered = await entering;
    assert.equal(entered.peerId, ME);
    assert.deepEqual(entered.iceServers, [{ urls: 'stun:example:1' }]);
    assert.equal(entered.state.code, 'ABC234');
  });

  it('takes a creator through the same door', async () => {
    const { socket, signaling } = connect();
    socket.open();
    const entering = signaling.enter({
      type: 'create-room',
      roomName: 'Kitchen',
      displayName: 'Sam',
    });
    socket.deliver({
      type: 'room-created',
      code: 'ABC234',
      peerId: ME,
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    socket.deliver(roster);

    assert.equal((await entering).peerId, ME);
  });

  it('waits for our own identity: a roster alone does not say which peer we are', async () => {
    const { socket, signaling } = connect();
    socket.open();
    let settled = false;
    const entering = signaling.enter(join).then(() => (settled = true));

    socket.deliver(roster);
    await Promise.resolve();
    assert.equal(settled, false);

    socket.deliver({ type: 'room-joined', code: 'ABC234', peerId: ME });
    socket.deliver(roster);
    await entering;
  });

  it("rejects with the server's own words and code, and hangs up, when refused", async () => {
    const { socket, signaling } = connect();
    socket.open();
    const entering = signaling.enter(join);
    socket.deliver({ type: 'error', code: 'passcode-required', message: 'This room needs a passcode.' });

    // The code as well as the words: the join screen asks for a passcode on
    // one refusal and not on another.
    await assert.rejects(entering, (err) => {
      assert.ok(err instanceof EnterRefused);
      assert.equal(err.message, 'This room needs a passcode.');
      assert.equal(err.code, 'passcode-required');
      return true;
    });
    assert.equal(socket.readyState, 3);
  });

  it('rejects when the socket drops before the room is entered', async () => {
    const { socket, signaling } = connect();
    const entering = signaling.enter(join);
    socket.drop();
    await assert.rejects(entering, { message: CONNECTION_LOST });
  });

  it("leaves no listener of its own behind, so a later drop is the room's to hear", async () => {
    const { socket, signaling } = connect();
    socket.open();
    const entering = signaling.enter(join);
    socket.deliver({ type: 'room-joined', code: 'ABC234', peerId: ME });
    socket.deliver(roster);
    await entering;

    assert.equal(socket.listening('close'), 0);
    // And an error after entering is not this handshake's to act on.
    socket.deliver({ type: 'error', code: 'not-creator', message: 'Not yours.' });
    assert.equal(socket.readyState, 1, 'the socket stays up');
  });
});

describe('watching the room list', () => {
  const room = {
    code: 'ABC234',
    roomName: 'Kitchen',
    description: '',
    memberCount: 1,
    hasPasscode: false,
    nowPlaying: null,
  };

  it('asks once, then hands on every list until told to stop', () => {
    const { socket, signaling } = connect();
    socket.open();
    const lists: unknown[] = [];
    const stop = signaling.watchRooms((rooms) => lists.push(rooms));
    assert.deepEqual(socket.sent, [{ type: 'watch-rooms' }]);

    socket.deliver({ type: 'room-list', rooms: [] });
    socket.deliver({ type: 'room-list', rooms: [room] });
    stop();
    socket.deliver({ type: 'room-list', rooms: [] });

    assert.deepEqual(lists, [[], [room]]);
  });
});
