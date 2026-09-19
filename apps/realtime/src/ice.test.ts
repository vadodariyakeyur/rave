import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { iceServers } from './ice.ts';

describe('iceServers', () => {
  it('defaults to public STUN when nothing is configured', () => {
    assert.deepEqual(iceServers({}), [{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    assert.deepEqual(iceServers({ ICE_SERVERS: 'stun:a:1, stun:b:2 ' }), [
      { urls: 'stun:a:1' },
      { urls: 'stun:b:2' },
    ]);
  });

  it('treats an empty value as host candidates only, not as unset', () => {
    // Overriding the default with nothing is how a LAN-only deployment says
    // "do not talk to Google" — it must not silently fall back.
    assert.deepEqual(iceServers({ ICE_SERVERS: '' }), []);
  });
});
