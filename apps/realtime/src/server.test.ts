import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { parseServerMessage, type ServerMessage } from '@rave/protocol';
import { handleConnection, rooms } from './server.ts';

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

function connect(): FakeSocket {
  const socket = new FakeSocket();
  handleConnection(socket as unknown as WebSocket);
  return socket;
}

/** A host and one joiner, already in the same room. */
function pair() {
  const host = connect();
  host.receive({ type: 'create-room', roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 10 });
  const created = host.last('room-created');

  const guest = connect();
  guest.receive({ type: 'join-room', code: created.code, displayName: 'Sam' });
  const joined = guest.last('room-joined');

  return { host, guest, hostId: created.peerId, guestId: joined.peerId, code: created.code };
}

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

describe('ready', () => {
  it('marks the sender ready and tells the whole room', () => {
    const { host, guest, guestId } = pair();
    assert.equal(guest.last('room-state').peers.find((p) => p.peerId === guestId)?.ready, false);

    guest.receive({ type: 'ready' });

    // The host is the one gating the Play button, so the host must see it.
    assert.equal(host.last('room-state').peers.find((p) => p.peerId === guestId)?.ready, true);
    assert.equal(guest.last('room-state').peers.find((p) => p.peerId === guestId)?.ready, true);
  });

  it('ignores a ready from a socket that is in no room', () => {
    // Otherwise a stray ready before join-room takes the server down.
    const stray = connect();
    stray.receive({ type: 'ready' });
    assert.equal(stray.sent.some((m) => m.type === 'room-state'), false);
  });
});

describe('start-playback', () => {
  /** A host and two joiners, so one can be left behind while another is not. */
  function trio() {
    const { host, guest, code, hostId } = pair();
    const other = connect();
    other.receive({ type: 'join-room', code, displayName: 'Ada' });
    return { host, guest, other, code, hostId, otherId: other.last('room-joined').peerId };
  }

  it('refuses without force while someone is still downloading', () => {
    const { host } = trio();
    host.receive({ type: 'start-playback', force: false });
    assert.equal(host.last('error').code, 'peers-not-ready');
  });

  it('locks the room and tells everyone once all are ready', () => {
    const { host, guest, other } = trio();
    guest.receive({ type: 'ready' });
    other.receive({ type: 'ready' });

    host.receive({ type: 'start-playback', force: false });

    assert.equal(host.last('room-state').locked, true);
    assert.equal(guest.last('room-state').locked, true);
    assert.equal(other.last('room-state').locked, true);
  });

  it('tells an excluded peer the room is over for them, and nobody else', () => {
    const { host, guest, other, otherId } = trio();
    guest.receive({ type: 'ready' });

    host.receive({ type: 'start-playback', force: true });

    assert.equal(other.last('room-closed').reason, 'excluded');
    // And then hung up on: nothing more will ever be said down that socket,
    // so holding it open just leaks one per excluded peer.
    assert.equal(other.closed, true);
    // The survivors must not see a room-closed of any kind: theirs is playing.
    assert.equal(host.sent.filter((m) => m.type === 'room-closed').length, 0);
    assert.equal(guest.sent.filter((m) => m.type === 'room-closed').length, 0);
    assert.equal(guest.last('room-state').peers.some((p) => p.peerId === otherId), false);
  });

  it('refuses a late join with the locked message', () => {
    const { host, guest } = trio();
    guest.receive({ type: 'ready' });
    host.receive({ type: 'start-playback', force: true });

    const late = connect();
    late.receive({ type: 'join-room', code: host.last('room-created').code, displayName: 'Late' });
    assert.equal(late.last('error').code, 'room-locked');
  });

  it('refuses a start from a peer who is not the creator', () => {
    const { guest } = trio();
    guest.receive({ type: 'start-playback', force: true });
    assert.equal(guest.last('error').code, 'not-creator');
  });

  it('survives an excluded peer hanging up afterwards', () => {
    // Their socket is still open and still thinks it belongs to a peer id.
    // The close handler must not then mutate a room they left.
    const { host, guest, other } = trio();
    guest.receive({ type: 'ready' });
    host.receive({ type: 'start-playback', force: true });

    const before = guest.sent.length;
    assert.doesNotThrow(() => other.hangUp());
    assert.equal(guest.sent.length, before, 'the survivors hear nothing about it');
  });
});
