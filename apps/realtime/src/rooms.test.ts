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
  it('creates a room whose creator is present, with nothing playing', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur'
    });

    assert.equal(room.peers.length, 1);
    const creator = room.peers[0]!;
    assert.equal(creator.isCreator, true);
    // A room starts empty: tracks are added from inside it.
    assert.equal(room.nowPlaying, null);
    assert.equal(room.description, '');
  });

  it('issues a createdAt that is UTC ISO-8601', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur'
    });
    assert.match(room.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('finds a room by its code', () => {
    const reg = new RoomRegistry();
    const room = reg.create({
      roomName: 'Kitchen',
      displayName: 'Keyur'
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
        displayName: 'Keyur'
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
      displayName: 'Keyur'
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
      displayName: 'Keyur'
    });
    const peerId = room.peers[0]!.peerId;
    reg.removePeer(peerId);
    // Removing twice must not throw or resurrect anything.
    reg.removePeer(peerId);
    assert.equal(reg.size, 0);
  });

  it('adds a joiner as a non-creator', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur' });

    const joined = reg.join(room.code, 'Sam');
    assert.equal(joined.ok, true);
    if (!joined.ok) return;

    assert.equal(joined.room.peers.length, 2);
    const peer = joined.room.peers.find((p) => p.peerId === joined.peerId)!;
    assert.equal(peer.displayName, 'Sam');
    assert.equal(peer.isCreator, false);
  });

  it('refuses a join for a code no room has', () => {
    const reg = new RoomRegistry();
    const joined = reg.join('ZZZZZZ', 'Sam');
    assert.equal(joined.ok, false);
    if (joined.ok) return;
    assert.equal(joined.reason, 'room-not-found');
  });

  it('keeps the room alive when a joiner leaves, and drops only them', () => {
    const reg = new RoomRegistry();
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur' });
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
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur' });
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
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur' });
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
    const room = reg.create({ roomName: 'Kitchen', displayName: 'Keyur' });
    // A creator-less room cannot arise through join(), so build the state
    // directly: this is the branch that must not say 'creator-left'.
    room.peers = room.peers.map((p) => ({ ...p, isCreator: false }));

    const result = reg.removePeer(room.peers[0]!.peerId);
    assert.deepEqual(result, { kind: 'closed', code: room.code, reason: 'room-empty' });
  });
});

describe('passcode', () => {
  function locked() {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur', passcode: 'hunter2' });
    return { registry, room };
  }

  it('asks for one when the room has it and the joiner sent none', () => {
    const { registry, room } = locked();
    assert.deepEqual(registry.join(room.code, 'Sam'), { ok: false, reason: 'passcode-required' });
  });

  it('refuses a wrong one, including one that is merely a prefix', () => {
    const { registry, room } = locked();
    for (const guess of ['nope', 'hunter', 'hunter22', '']) {
      assert.deepEqual(registry.join(room.code, 'Sam', guess), { ok: false, reason: 'passcode-wrong' });
    }
    assert.equal(room.peers.length, 1, 'nobody got in');
  });

  it('lets the right one in', () => {
    const { registry, room } = locked();
    assert.equal(registry.join(room.code, 'Sam', 'hunter2').ok, true);
  });

  it('ignores a passcode offered to a room that has none', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur' });
    assert.equal(registry.join(room.code, 'Sam', 'whatever').ok, true);
  });

  it('says a room has one in the list, and never what it is', () => {
    const { registry } = locked();
    const [summary] = registry.list();
    assert.equal(summary?.hasPasscode, true);
    assert.equal(JSON.stringify(registry.list()).includes('hunter2'), false);
    assert.equal(JSON.stringify(registry.toState(registry.get(summary!.code)!)).includes('hunter2'), false);
  });
});

describe('kick', () => {
  function trio() {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur' });
    const creatorId = room.peers[0]!.peerId;
    const sam = registry.join(room.code, 'Sam');
    const ada = registry.join(room.code, 'Ada');
    assert.ok(sam.ok && ada.ok);
    return { registry, room, creatorId, samId: sam.peerId, adaId: ada.peerId };
  }

  it('removes the member and leaves the rest', () => {
    const { registry, room, creatorId, samId, adaId } = trio();
    assert.equal(registry.kick(creatorId, samId).ok, true);
    assert.deepEqual(room.peers.map((p) => p.peerId), [creatorId, adaId]);
    assert.equal(registry.roomForPeer(samId), undefined);
  });

  it('is the creator\'s alone', () => {
    const { registry, samId, adaId } = trio();
    assert.deepEqual(registry.kick(samId, adaId), { ok: false, reason: 'not-creator' });
  });

  it('cannot reach into another room, or remove the creator', () => {
    const { registry, creatorId } = trio();
    const other = trio();
    assert.deepEqual(registry.kick(creatorId, other.samId), { ok: false, reason: 'peer-not-found' });
    assert.deepEqual(registry.kick(creatorId, creatorId), { ok: false, reason: 'peer-not-found' });
  });

  it('remembers nothing: the kicked can join again', () => {
    const { registry, room, creatorId, samId } = trio();
    registry.kick(creatorId, samId);
    assert.equal(registry.join(room.code, 'Sam').ok, true);
  });
});

describe('the room list', () => {
  it('shows each live room with its head count and what is playing', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur', description: 'Friday' });
    registry.join(room.code, 'Sam');
    registry.setNowPlaying(room.peers[0]!.peerId, 'track.mp3');

    assert.deepEqual(registry.list(), [
      {
        code: room.code,
        roomName: 'Kitchen',
        description: 'Friday',
        memberCount: 2,
        hasPasscode: false,
        nowPlaying: 'track.mp3',
      },
    ]);
  });

  it('takes what is playing only from the creator', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur' });
    const sam = registry.join(room.code, 'Sam');
    assert.ok(sam.ok);
    assert.equal(registry.setNowPlaying(sam.peerId, 'mine.mp3'), undefined);
    assert.equal(room.nowPlaying, null);
  });

  it('drops a room when it closes', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ roomName: 'Kitchen', displayName: 'Keyur' });
    registry.removePeer(room.peers[0]!.peerId);
    assert.deepEqual(registry.list(), []);
  });
});
