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
    reg.removePeer(room.peers[0]!.peerId);
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
});
