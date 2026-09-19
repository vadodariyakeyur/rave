import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage, parseServerMessage, PROTOCOL_VERSION } from './index.ts';

test('parses a valid client message', () => {
  const msg = parseClientMessage(JSON.stringify({ type: 'ping', nonce: 'abc' }));
  assert.deepEqual(msg, { type: 'ping', nonce: 'abc' });
});

test('parses a valid server message', () => {
  const raw = JSON.stringify({
    type: 'server-hello',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: '2026-09-19T12:00:00.000Z',
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
