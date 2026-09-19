import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  RoomCode,
} from './index.ts';

test('parses a valid client message', () => {
  const msg = parseClientMessage(JSON.stringify({ type: 'ping', nonce: 'abc' }));
  assert.deepEqual(msg, { type: 'ping', nonce: 'abc' });
});

test('parses a valid server message', () => {
  const raw = JSON.stringify({
    type: 'server-hello',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: '2026-09-19T12:00:00.000Z',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  assert.equal(parseServerMessage(raw)?.type, 'server-hello');
});

// A trust boundary: malformed input must return null, never throw, never pass through.
for (const [name, raw] of [
  ['malformed json', '{not json'],
  ['unknown type', '{"type":"evil"}'],
  ['missing field', '{"type":"ping"}'],
  ['empty nonce', '{"type":"ping","nonce":""}'],
  ['wrong protocol version', '{"type":"server-hello","protocolVersion":99,"serverTime":"2026-09-19T12:00:00.000Z"}'],
  ['bad timestamp', '{"type":"server-hello","protocolVersion":1,"serverTime":"not-a-date"}'],
  ['null', 'null'],
] as const) {
  test(`rejects ${name}`, () => {
    assert.equal(parseClientMessage(raw), null);
    assert.equal(parseServerMessage(raw), null);
  });
}

test('oversized nonce is rejected', () => {
  const raw = JSON.stringify({ type: 'ping', nonce: 'x'.repeat(65) });
  assert.equal(parseClientMessage(raw), null);
});

describe('room code', () => {
  it('accepts a well-formed code', () => {
    assert.equal(RoomCode.parse('ABC234'), 'ABC234');
  });

  it('normalises case and surrounding whitespace', () => {
    // People type room codes by hand, often pasted with a stray space.
    assert.equal(RoomCode.parse('  abc234 '), 'ABC234');
  });

  it('rejects codes containing ambiguous characters', () => {
    // 0/O and 1/I/L are excluded precisely because they get misheard.
    for (const bad of ['ABC23O', 'ABC23I', 'ABC2L4', 'ABC201']) {
      assert.equal(RoomCode.safeParse(bad).success, false, bad);
    }
  });

  it('rejects codes of the wrong length', () => {
    for (const bad of ['ABC23', 'ABC2345', '']) {
      assert.equal(RoomCode.safeParse(bad).success, false, bad);
    }
  });
});

describe('create-room', () => {
  const valid = {
    type: 'create-room',
    roomName: 'Kitchen',
    displayName: 'Keyur',
    durationSeconds: 212.5,
  };

  it('parses a valid create-room message', () => {
    const msg = parseClientMessage(JSON.stringify(valid));
    assert.equal(msg?.type, 'create-room');
  });

  it('trims a padded display name', () => {
    const msg = parseClientMessage(
      JSON.stringify({ ...valid, displayName: '  Keyur  ' }),
    );
    assert.equal(msg?.type === 'create-room' && msg.displayName, 'Keyur');
  });

  it('rejects malformed create-room messages', () => {
    const bad = [
      { ...valid, roomName: '' },
      { ...valid, roomName: '   ' },
      { ...valid, displayName: '' },
      { ...valid, durationSeconds: 0 },
      { ...valid, durationSeconds: -5 },
      { ...valid, durationSeconds: Number.POSITIVE_INFINITY },
      { ...valid, durationSeconds: 'long' },
      { ...valid, roomName: 'x'.repeat(65) },
      { ...valid, displayName: 'x'.repeat(33) },
    ];
    for (const b of bad) {
      assert.equal(parseClientMessage(JSON.stringify(b)), null, JSON.stringify(b));
    }
  });
});

describe('server room messages', () => {
  it('parses room-created', () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: 'room-created',
        code: 'ABC234',
        peerId: '6f1b3c7e-4f3a-4b2e-8f1a-2c3d4e5f6a7b',
        createdAt: '2026-09-19T07:50:00.000Z',
      }),
    );
    assert.equal(msg?.type, 'room-created');
  });

  it('rejects room-created with a non-UUID peer id', () => {
    assert.equal(
      parseServerMessage(
        JSON.stringify({
          type: 'room-created',
          code: 'ABC234',
          peerId: 'not-a-uuid',
          createdAt: '2026-09-19T07:50:00.000Z',
        }),
      ),
      null,
    );
  });

  it('parses room-state with a roster', () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: 'room-state',
        code: 'ABC234',
        roomName: 'Kitchen',
        locked: false,
        peers: [
          {
            peerId: '6f1b3c7e-4f3a-4b2e-8f1a-2c3d4e5f6a7b',
            displayName: 'Keyur',
            isCreator: true,
            ready: true,
          },
        ],
      }),
    );
    assert.equal(msg?.type === 'room-state' && msg.peers.length, 1);
  });

  it('parses join-room and normalises the code', () => {
    const msg = parseClientMessage(
      JSON.stringify({ type: 'join-room', code: 'abc234', displayName: 'Keyur' }),
    );
    // Codes are read aloud and typed by hand, so case is not the sender's problem.
    assert.equal(msg?.type === 'join-room' && msg.code, 'ABC234');
  });

  it('rejects join-room with a code that is not a room code', () => {
    for (const code of ['ABC23', 'ABC2345', 'ABC2O4', 'ABC2 4', '']) {
      assert.equal(
        parseClientMessage(JSON.stringify({ type: 'join-room', code, displayName: 'Keyur' })),
        null,
        `expected ${JSON.stringify(code)} to be rejected`,
      );
    }
  });

  it('rejects join-room with a blank display name', () => {
    assert.equal(
      parseClientMessage(JSON.stringify({ type: 'join-room', code: 'ABC234', displayName: '  ' })),
      null,
    );
  });

  it('parses room-closed', () => {
    const msg = parseServerMessage(
      JSON.stringify({ type: 'room-closed', code: 'ABC234', reason: 'creator-left' }),
    );
    assert.equal(msg?.type === 'room-closed' && msg.reason, 'creator-left');
  });

  it('parses room-closed for a room that simply emptied', () => {
    const msg = parseServerMessage(
      JSON.stringify({ type: 'room-closed', code: 'ABC234', reason: 'room-empty' }),
    );
    assert.equal(msg?.type === 'room-closed' && msg.reason, 'room-empty');
  });

  it('rejects room-closed with an unknown reason', () => {
    assert.equal(
      parseServerMessage(JSON.stringify({ type: 'room-closed', code: 'ABC234', reason: 'bored' })),
      null,
    );
  });

  it('parses a room-joined message', () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: 'room-joined',
        code: 'ABC234',
        peerId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    assert.equal(msg?.type, 'room-joined');
  });

  it('rejects a room-joined message without a peer id', () => {
    const msg = parseServerMessage(JSON.stringify({ type: 'room-joined', code: 'ABC234' }));
    assert.equal(msg, null);
  });

  it('rejects an error message with an unknown code', () => {
    assert.equal(
      parseServerMessage(
        JSON.stringify({ type: 'error', code: 'nope', message: 'x' }),
      ),
      null,
    );
  });
  it('relays a signal with an opaque payload', () => {
    // The server must not care what is inside: an SDP blob today, whatever
    // the browser sends tomorrow.
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'signal',
        to: '6f1b3c7e-4f3a-4b2e-8f1a-2c3d4e5f6a7b',
        data: { sdp: 'v=0...', type: 'offer' },
      }),
    );
    assert.equal(msg?.type, 'signal');
  });

  it('rejects a signal addressed to something that is not a peer id', () => {
    assert.equal(
      parseClientMessage(JSON.stringify({ type: 'signal', to: 'everyone', data: {} })),
      null,
    );
  });

  it('parses an inbound signal stamped with its sender', () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: 'signal',
        from: '6f1b3c7e-4f3a-4b2e-8f1a-2c3d4e5f6a7b',
        data: null,
      }),
    );
    assert.equal(msg?.type === 'signal' && msg.from, '6f1b3c7e-4f3a-4b2e-8f1a-2c3d4e5f6a7b');
  });

});

test('carries an ice server list with optional turn credentials', () => {
  // TURN lands in phase 2 and needs credentials; the shape has to already
  // hold them or the message changes under a deployed client.
  const raw = JSON.stringify({
    type: 'server-hello',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: '2026-09-19T12:00:00.000Z',
    iceServers: [{ urls: ['turn:t:3478'], username: 'u', credential: 'p' }],
  });
  const msg = parseServerMessage(raw);
  assert.equal(msg?.type, 'server-hello');
  assert.deepEqual(msg.iceServers[0], { urls: ['turn:t:3478'], username: 'u', credential: 'p' });
});

test('rejects a server-hello with no ice server list at all', () => {
  // An absent list is a server that forgot to send one; an empty list is a
  // deliberate host-candidates-only deployment. They must not be the same.
  const raw = JSON.stringify({
    type: 'server-hello',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: '2026-09-19T12:00:00.000Z',
  });
  assert.equal(parseServerMessage(raw), null);
});

describe('ready', () => {
  it('parses a ready message', () => {
    assert.equal(parseClientMessage(JSON.stringify({ type: 'ready' }))?.type, 'ready');
  });

  it('takes no payload, so a peer cannot mark anyone else ready', () => {
    // Readiness is a fact about the sender's own device. The server knows
    // which socket sent this; a peerId field would be a claim to check.
    assert.equal(
      parseClientMessage(JSON.stringify({ type: 'ready', peerId: '11111111-1111-4111-8111-111111111111' })),
      null,
    );
  });
});
