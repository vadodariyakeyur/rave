import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { parseServerMessage, type ServerMessage } from '@rave/protocol';
import { RoomHub } from './hub.ts';
import { RoomRegistry } from './rooms.ts';
import { connectionHandler } from './server.ts';

/**
 * A socket that records what the server sent it and lets a test push a
 * message back in — enough of the ws surface for the handler, and nothing
 * more.
 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  readonly #listeners = new Map<string, ((arg: never) => void)[]>();

  on(event: string, handler: (arg: never) => void): this {
    const existing = this.#listeners.get(event) ?? [];
    this.#listeners.set(event, [...existing, handler]);
    return this;
  }

  send(raw: string): void {
    const msg = parseServerMessage(raw);
    assert.ok(msg, `server sent something unparseable: ${raw}`);
    this.sent.push(msg);
  }

  /** Drive the handler as if bytes arrived from this client. */
  receive(msg: unknown): void {
    for (const h of this.#listeners.get('message') ?? []) {
      (h as (b: Buffer) => void)(Buffer.from(JSON.stringify(msg)));
    }
  }

  /** The server hanging up on us, as opposed to us hanging up on it. */
  close(): void {
    this.closed = true;
    this.hangUp();
  }

  closed = false;

  hangUp(): void {
    this.readyState = 3;
    for (const h of this.#listeners.get('close') ?? []) (h as () => void)();
  }

  /** The last message of a given type, which is what a test usually means. */
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const found = [...this.sent].reverse().find((m) => m.type === type);
    assert.ok(found, `no ${type} was sent; got ${this.sent.map((m) => m.type).join(', ')}`);
    return found as Extract<ServerMessage, { type: T }>;
  }
}

// A server per test: no room, socket or histogram count carries over.
let handleConnection: (socket: WebSocket) => void;

beforeEach(() => {
  handleConnection = connectionHandler(new RoomHub({ rooms: new RoomRegistry() }));
});

function connect(): FakeSocket {
  const socket = new FakeSocket();
  handleConnection(socket as unknown as WebSocket);
  return socket;
}

/** A host and one joiner, already in the same room. */
function pair(extra: { passcode?: string } = {}) {
  const host = connect();
  host.receive({ type: 'create-room', roomName: 'Kitchen', displayName: 'Keyur', ...extra });
  const created = host.last('room-created');

  const guest = connect();
  guest.receive({ type: 'join-room', code: created.code, displayName: 'Sam', ...extra });
  const joined = guest.last('room-joined');

  return { host, guest, hostId: created.peerId, guestId: joined.peerId, code: created.code };
}

describe('reactions', () => {
  it('reach everyone else in the room, stamped with who sent them, and not the sender', () => {
    const { host, guest, hostId } = pair();
    const other = connect();
    other.receive({ type: 'join-room', code: guest.last('room-joined').code, displayName: 'Ada' });

    host.receive({ type: 'react', reaction: 'fire' });

    for (const socket of [guest, other]) {
      const heard = socket.last('reaction');
      assert.equal(heard.from, hostId);
      assert.equal(heard.reaction, 'fire');
    }
    assert.equal(host.sent.filter((m) => m.type === 'reaction').length, 0);
  });

  it('stay inside their room', () => {
    const a = pair();
    const b = pair();
    a.host.receive({ type: 'react', reaction: 'heart' });
    assert.equal(b.host.sent.filter((m) => m.type === 'reaction').length, 0);
    assert.equal(b.guest.sent.filter((m) => m.type === 'reaction').length, 0);
  });

  it('are dropped, silently, past five a second', () => {
    const { host, guest } = pair();
    for (let i = 0; i < 12; i++) host.receive({ type: 'react', reaction: 'party' });
    assert.equal(guest.sent.filter((m) => m.type === 'reaction').length, 5);
    assert.equal(host.sent.filter((m) => m.type === 'error').length, 0, 'no error for a held-down button');
  });

  it('are ignored from a socket that is in no room, and refused when they are not one of the fixed few', () => {
    const stranger = connect();
    stranger.receive({ type: 'react', reaction: 'heart' });
    assert.equal(stranger.sent.filter((m) => m.type === 'reaction' || m.type === 'error').length, 0);

    const { host, guest } = pair();
    host.receive({ type: 'react', reaction: '<script>' });
    assert.equal(host.last('error').code, 'invalid-request');
    assert.equal(guest.sent.filter((m) => m.type === 'reaction').length, 0);
  });
});

describe('signal relay', () => {
  it('forwards a payload to the addressed peer, stamped with the sender', () => {
    const { host, guest, hostId } = pair();
    const offer = { type: 'offer', sdp: 'v=0 ...' };

    host.receive({ type: 'signal', to: guest.last('room-joined').peerId, data: offer });

    const relayed = guest.last('signal');
    assert.equal(relayed.from, hostId);
    assert.deepEqual(relayed.data, offer);
  });

  it('does not echo the signal back to its sender', () => {
    const { host, guest } = pair();
    const before = host.sent.length;
    host.receive({ type: 'signal', to: guest.last('room-joined').peerId, data: {} });
    assert.equal(host.sent.slice(before).filter((m) => m.type === 'signal').length, 0);
  });

  it('refuses to address a peer in a different room', () => {
    const a = pair();
    const b = pair();

    a.host.receive({ type: 'signal', to: b.guestId, data: { sdp: 'nope' } });

    assert.equal(a.host.last('error').code, 'peer-not-found');
    // The point of the guard: nothing reached the stranger.
    assert.equal(b.guest.sent.filter((m) => m.type === 'signal').length, 0);
  });

  it('refuses a signal from a socket that has not joined a room', () => {
    const { guestId } = pair();
    const stranger = connect();

    stranger.receive({ type: 'signal', to: guestId, data: {} });

    assert.equal(stranger.last('error').code, 'peer-not-found');
  });

  it('refuses a signal to a peer that has left', () => {
    const { host, guest, guestId } = pair();
    guest.hangUp();

    host.receive({ type: 'signal', to: guestId, data: {} });

    assert.equal(host.last('error').code, 'peer-not-found');
  });
});

describe('kick', () => {
  it('tells the kicked member, hangs up on them, and shows the rest a roster without them', () => {
    const { host, guest, guestId } = pair();

    host.receive({ type: 'kick', peerId: guestId });

    assert.equal(guest.last('room-closed').reason, 'kicked');
    assert.equal(guest.closed, true);
    assert.equal(host.last('room-state').peers.some((p) => p.peerId === guestId), false);
    assert.equal(host.sent.filter((m) => m.type === 'room-closed').length, 0);
  });

  it('lets a kicked member join again on a new connection', () => {
    const { host, guestId, code } = pair();
    host.receive({ type: 'kick', peerId: guestId });

    const back = connect();
    back.receive({ type: 'join-room', code, displayName: 'Sam' });

    assert.equal(back.last('room-joined').code, code);
    assert.equal(host.last('room-state').peers.length, 2);
  });
});

describe('passcode', () => {
  it('keeps out a joiner without it and lets in one with it', () => {
    const { code, host } = pair({ passcode: 'hunter2' });

    const stranger = connect();
    stranger.receive({ type: 'join-room', code, displayName: 'Ada' });
    assert.equal(stranger.last('error').code, 'passcode-required');
    assert.equal(host.last('room-state').peers.length, 2, 'still just the two');

    // The same socket may try again: asking was not a strike.
    stranger.receive({ type: 'join-room', code, displayName: 'Ada', passcode: 'hunter2' });
    assert.equal(stranger.last('room-joined').code, code);
  });

  it('hangs up on a socket that keeps guessing', () => {
    const { code } = pair({ passcode: 'hunter2' });
    const guesser = connect();

    for (let i = 0; i < 4; i++) {
      guesser.receive({ type: 'join-room', code, displayName: 'Ada', passcode: `guess${i}` });
    }
    assert.equal(guesser.closed, false, 'a few typos are forgiven');

    guesser.receive({ type: 'join-room', code, displayName: 'Ada', passcode: 'guess4' });
    assert.equal(guesser.closed, true);
  });
});

describe('the room list', () => {
  it('reaches a watcher at once, and again whenever a room changes', () => {
    const watcher = connect();
    watcher.receive({ type: 'watch-rooms' });
    assert.deepEqual(watcher.last('room-list').rooms, []);

    const { host, guest } = pair();
    assert.equal(watcher.last('room-list').rooms[0]?.memberCount, 2);

    host.receive({ type: 'now-playing', title: 'track.mp3' });
    assert.equal(watcher.last('room-list').rooms[0]?.nowPlaying, 'track.mp3');

    guest.hangUp();
    assert.equal(watcher.last('room-list').rooms[0]?.memberCount, 1);

    host.hangUp();
    assert.deepEqual(watcher.last('room-list').rooms, []);
  });

  it('stops going to a watcher who has left the homepage', () => {
    const watcher = connect();
    watcher.receive({ type: 'watch-rooms' });
    watcher.hangUp();
    const before = watcher.sent.length;

    pair();
    assert.equal(watcher.sent.length, before);
  });

  it('is not sent to people who never asked', () => {
    const { host } = pair();
    assert.equal(host.sent.some((m) => m.type === 'room-list'), false);
  });
});
