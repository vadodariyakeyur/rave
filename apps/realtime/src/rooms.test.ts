import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, generateRoomCode } from './rooms.ts';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@rave/protocol';

describe('generateRoomCode', () => {
  it('produces a code of the agreed shape', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      assert.equal(code.length, ROOM_CODE_LENGTH);
      for (const ch of code) {
        assert.ok(ROOM_CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);
      }
    }
  });

  it('does not repeat within a reasonable sample', () => {
    // Not a uniqueness guarantee — the registry enforces that. This only
    // catches a generator that is accidentally constant or low-entropy.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateRoomCode());
    assert.ok(seen.size > 490, `only ${seen.size} distinct codes in 500`);
  });
});

describe('RoomRegistry', () => {
  it('creates a room whose creator is present and ready', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 100,
    });

    assert.equal(room.peers.length, 1);
    const creator = room.peers[0]!;
    assert.equal(creator.isCreator, true);
    // The creator already holds the file — they chose it.
    assert.equal(creator.ready, true);
    assert.equal(room.locked, false);
  });

  it('issues a createdAt that is UTC ISO-8601', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 100,
    });
    assert.match(room.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('finds a room by its code', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 100,
    });
    assert.equal(reg.get(room.code)?.code, room.code);
  });

  it('returns undefined for an unknown code', () => {
    assert.equal(new RoomRegistry().get('ZZZZZZ'), undefined);
  });

  it('never issues the same code to two live rooms', () => {
    const reg = new RoomRegistry();
    const codes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const room = reg.create({
        roomName: `Room ${i}`,
        displayName: 'Keyur',
        durationSeconds: 100,
      });
      assert.equal(codes.has(room.code), false, `duplicate ${room.code}`);
      codes.add(room.code);
    }
  });

  it('drops a room when its creator leaves', () => {
    // The creator is the clock master; without them the room cannot play.
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 100,
    });
    const result = reg.removePeer(room.peers[0]!.peerId);
    // The reason is what the survivors are told, so it has to name the
    // creator leaving rather than the room merely emptying.
    assert.deepEqual(result, { kind: 'closed', code: room.code, reason: 'creator-left' });
    assert.equal(reg.get(room.code), undefined);
  });

  it('forgets a peer id after the room is gone', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur',
      durationSeconds: 100,
    });
    const peerId = room.peers[0]!.peerId;
    reg.removePeer(peerId);
    // Removing twice must not throw or resurrect anything.
    reg.removePeer(peerId);
    assert.equal(reg.size, 0);
  });

  it('adds a joiner as a non-creator who is not yet ready', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });

    const joined = reg.join(room.code, 'Sam');
    assert.equal(joined.ok, true);
    if (!joined.ok) return;

    assert.equal(joined.room.peers.length, 2);
    const peer = joined.room.peers.find((p) => p.peerId === joined.peerId)!;
    assert.equal(peer.displayName, 'Sam');
    assert.equal(peer.isCreator, false);
    // Nothing has been transferred yet — ready is earned in #5, not on arrival.
    assert.equal(peer.ready, false);
  });

  it('refuses a join for a code no room has', () => {
    const reg = new RoomRegistry();
    const joined = reg.join('ZZZZZZ', 'Sam');
    assert.equal(joined.ok, false);
    if (joined.ok) return;
    assert.equal(joined.reason, 'room-not-found');
  });

  it('refuses a join once the room is locked', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    room.locked = true;

    const joined = reg.join(room.code, 'Sam');
    assert.equal(joined.ok, false);
    if (joined.ok) return;
    assert.equal(joined.reason, 'room-locked');
  });

  it('keeps the room alive when a joiner leaves, and drops only them', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    const joined = reg.join(room.code, 'Sam');
    assert.ok(joined.ok);

    const result = reg.removePeer(joined.peerId);
    assert.equal(result.kind, 'open');
    if (result.kind !== 'open') return;
    assert.equal(result.room.code, room.code);
    assert.equal(result.room.peers.length, 1);
    assert.equal(reg.get(room.code)?.peers.length, 1);
  });

  it('closes the room out from under joiners when the creator leaves', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    const joined = reg.join(room.code, 'Sam');
    assert.ok(joined.ok);

    const result = reg.removePeer(room.peers[0]!.peerId);
    // The reason is what the survivors are told, so it has to name the
    // creator leaving rather than the room merely emptying.
    assert.deepEqual(result, { kind: 'closed', code: room.code, reason: 'creator-left' });
    assert.equal(reg.get(room.code), undefined);
    // The joiner's reverse index must go too, or their later close event
    // would point at a room that no longer exists.
    assert.equal(reg.roomForPeer(joined.peerId), undefined);
    assert.equal(reg.size, 0);
  });

  it('reports an empty room as empty, not as the creator leaving', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    const joined = reg.join(room.code, 'Sam');
    assert.ok(joined.ok);

    // Creator first, then the last joiner: the second removal empties a room
    // that already has no creator in it.
    reg.removePeer(room.peers[0]!.peerId);
    const result = reg.removePeer(joined.peerId);
    assert.equal(result.kind, 'unknown');
  });

  it('closes an emptied room when its last peer leaves', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    // A creator-less room cannot arise through join(), so build the state
    // directly: this is the branch that must not say 'creator-left'.
    room.peers = room.peers.map((p) => ({ ...p, isCreator: false }));

    const result = reg.removePeer(room.peers[0]!.peerId);
    assert.deepEqual(result, { kind: 'closed', code: room.code, reason: 'room-empty' });
  });
});

describe('setReady', () => {
  it('flips a joiner to ready and reports the room it is in', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur', durationSeconds: 100 });
    const joined = reg.join(room.code, 'Ada');
    assert.ok(joined.ok);

    const found = reg.setReady(joined.peerId);
    assert.equal(found?.code, room.code);
    assert.equal(found?.peers.find((p) => p.peerId === joined.peerId)?.ready, true);
  });

  it('is unknown for a peer in no room, rather than throwing', () => {
    // A ready can race a disconnect; the socket handler must be able to
    // shrug rather than take the process down.
    const reg = new RoomRegistry();
    assert.equal(reg.setReady('11111111-1111-4111-8111-111111111111'), undefined);
  });
});
