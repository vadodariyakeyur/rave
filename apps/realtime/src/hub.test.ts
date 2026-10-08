import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, ServerMessage } from '@rave/protocol';
import { RoomHub, type Outcome } from './hub.ts';
import { RoomRegistry } from './rooms.ts';

/**
 * The hub's own rule: a roster change reaches the whole room and marks the
 * room list stale, on every path, without the path having to say so. No
 * socket anywhere — what comes out is who must hear what.
 */

const hub = () => new RoomHub({ rooms: new RoomRegistry() });

const create = { type: 'create-room', roomName: 'Kitchen', displayName: 'Keyur' } as const;

/** Who was sent a message of this type. */
function heard(outcome: Outcome, type: ServerMessage['type']): string[] {
  return outcome.deliveries.filter((d) => d.msg.type === type).map((d) => d.to);
}

/** A creator and one joiner. */
function pair(h: RoomHub, extra: Partial<Extract<ClientMessage, { type: 'create-room' }>> = {}) {
  const created = h.handle(undefined, { ...create, ...extra });
  const hostId = created.identity!;
  const code = (created.reply[0] as Extract<ServerMessage, { type: 'room-created' }>).code;
  const joined = h.handle(undefined, {
    type: 'join-room',
    code,
    displayName: 'Sam',
    passcode: extra.passcode,
  });
  return { hostId, guestId: joined.identity!, code, joined };
}

describe('RoomHub', () => {
  it('gives a creator an identity, then the roster', () => {
    const outcome = hub().handle(undefined, create);

    assert.ok(outcome.identity);
    assert.equal(outcome.reply[0]?.type, 'room-created');
    assert.deepEqual(heard(outcome, 'room-state'), [outcome.identity]);
  });

  it('tells the whole room about a join, the joiner included', () => {
    const { hostId, guestId, joined } = pair(hub());

    assert.equal(joined.reply[0]?.type, 'room-joined');
    assert.deepEqual(heard(joined, 'room-state').sort(), [hostId, guestId].sort());
  });

  it('refuses a second room on a connection that already has one', () => {
    const h = hub();
    const { hostId } = pair(h);
    const outcome = h.handle(hostId, create);

    assert.equal(outcome.identity, undefined);
    assert.equal(outcome.reply[0]?.type, 'error');
    assert.deepEqual(outcome.deliveries, []);
  });

  it('addresses a relayed signal to its target alone, stamped with the sender', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.handle(hostId, { type: 'signal', to: guestId, data: { sdp: 'x' } });

    assert.deepEqual(outcome.deliveries, [
      { to: guestId, msg: { type: 'signal', from: hostId, data: { sdp: 'x' } } },
    ]);
  });

  it('tells the survivors why the room ended when the creator leaves', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.leave(hostId);

    assert.deepEqual(heard(outcome, 'room-closed'), [guestId]);
    const closed = outcome.deliveries[0]!.msg as Extract<ServerMessage, { type: 'room-closed' }>;
    assert.equal(closed.reason, 'creator-left');
  });

  it('says nothing when someone in no room leaves', () => {
    assert.deepEqual(hub().leave('nobody').deliveries, []);
  });
});

describe('joining with a passcode', () => {
  it('refuses, giving no identity, and says which way it was wrong', () => {
    const h = hub();
    const { code } = pair(h, { passcode: 'hunter2' });

    const none = h.handle(undefined, { type: 'join-room', code, displayName: 'Ada' });
    const wrong = h.handle(undefined, { type: 'join-room', code, displayName: 'Ada', passcode: 'nope' });

    for (const [outcome, reason] of [[none, 'passcode-required'], [wrong, 'passcode-wrong']] as const) {
      assert.equal(outcome.identity, undefined);
      assert.deepEqual(outcome.deliveries, [], 'the room hears nothing of a failed attempt');
      assert.equal((outcome.reply[0] as Extract<ServerMessage, { type: 'error' }>).code, reason);
    }
  });
});

describe('kick', () => {
  it('tells the kicked why, drops them, and gives the rest a roster without them', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.handle(hostId, { type: 'kick', peerId: guestId });

    assert.deepEqual(heard(outcome, 'room-closed'), [guestId]);
    assert.equal(
      (outcome.deliveries[0]!.msg as Extract<ServerMessage, { type: 'room-closed' }>).reason,
      'kicked',
    );
    assert.deepEqual(heard(outcome, 'room-state'), [hostId]);
    assert.deepEqual(outcome.dropped, [guestId]);
  });

  it('refuses anyone but the creator', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.handle(guestId, { type: 'kick', peerId: hostId });

    assert.equal((outcome.reply[0] as Extract<ServerMessage, { type: 'error' }>).code, 'not-creator');
    assert.deepEqual(outcome.dropped, []);
  });
});

describe('the room list, as a consequence of the roster', () => {
  it('goes to whoever asks to watch', () => {
    const h = hub();
    pair(h);
    const outcome = h.handle(undefined, { type: 'watch-rooms' });

    assert.equal(outcome.watch, true);
    const list = outcome.reply[0] as Extract<ServerMessage, { type: 'room-list' }>;
    assert.equal(list.rooms[0]?.memberCount, 2);
  });

  it('is stale after every change to who is in a room', () => {
    const h = hub();
    const created = h.handle(undefined, create);
    const { hostId, guestId, joined } = pair(h);

    assert.equal(created.listChanged, true, 'a room appeared');
    assert.equal(joined.listChanged, true, 'a head count moved');
    assert.equal(h.handle(hostId, { type: 'kick', peerId: guestId }).listChanged, true);
    assert.equal(h.leave(hostId).listChanged, true, 'a room went away');
  });

  it('is stale when the creator says what is playing, and only the creator', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);

    assert.equal(h.handle(hostId, { type: 'now-playing', title: 'track.mp3' }).listChanged, true);
    assert.equal(h.list().rooms[0]?.nowPlaying, 'track.mp3');
    assert.equal(h.handle(guestId, { type: 'now-playing', title: 'mine.mp3' }).listChanged, undefined);
    assert.equal(h.list().rooms[0]?.nowPlaying, 'track.mp3');
  });

  it('is not stale for a relayed signal or a refused join', () => {
    const h = hub();
    const { hostId, guestId } = pair(h);
    assert.equal(h.handle(hostId, { type: 'signal', to: guestId, data: {} }).listChanged, undefined);
    assert.equal(
      h.handle(undefined, { type: 'join-room', code: 'ZZZZZZ', displayName: 'Ada' }).listChanged,
      undefined,
    );
  });
});
