import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { qrPath } from './JoinQr';

describe('qrPath', () => {
  it('encodes a join URL as a square grid of modules', () => {
    const { path, size } = qrPath('https://192.168.1.17/room/F5CVCR');
    // Version 1 is 21x21 and every version adds 4; anything outside that
    // range means the grid was not read off a real QR code.
    assert.ok(size >= 21 && size <= 177, `implausible module count: ${size}`);
    assert.equal((size - 21) % 4, 0, 'module count is not a valid QR version');
    assert.match(path, /^M\d+,\d+h1v1h-1z/, 'path does not start with a module');
  });

  it('keeps every module inside the grid', () => {
    const { path, size } = qrPath('https://192.168.1.17/room/F5CVCR');
    // A module drawn at `size` would be one row past the edge — the kind of
    // off-by-one that still renders, just as an unscannable code.
    const coords = [...path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
    assert.ok(coords.length > 0, 'no modules drawn');
    for (const [, col, row] of coords) {
      assert.ok(Number(col) < size && Number(row) < size, `module ${col},${row} is off-grid`);
    }
  });

  it('gives different codes for different rooms', () => {
    // The finder patterns are identical between any two codes, so a helper
    // that ignored its argument would still look plausible in isolation.
    const a = qrPath('https://192.168.1.17/room/AAAAAA');
    const b = qrPath('https://192.168.1.17/room/ZZZZZZ');
    assert.notEqual(a.path, b.path);
  });
});
