import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePasscode, encodePasscode } from './passcode';

describe('passcode in a link', () => {
  it('is not the passcode, and comes back as it was, whatever it contains', () => {
    for (const passcode of ['hunter2', 'a?b/c+d=e', 'pässwörd', '密码🔒', 'x'.repeat(32)]) {
      const encoded = encodePasscode(passcode);
      assert.notEqual(encoded, passcode);
      assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'safe in a fragment without escaping');
      assert.equal(decodePasscode(encoded), passcode);
    }
  });

  it('reads anything else as no passcode', () => {
    assert.equal(decodePasscode('%%%'), undefined);
    // Valid base64 that is not UTF-8.
    assert.equal(decodePasscode('_w'), undefined);
  });
});
