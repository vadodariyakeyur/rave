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
