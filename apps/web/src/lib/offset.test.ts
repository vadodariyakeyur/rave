import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadUserOffset, saveUserOffset } from './offset.ts';

/** Enough of localStorage to exercise the boundary, plus a way to break it. */
function storage() {
  const map = new Map<string, string>();
  const fake = {
    throws: false,
    getItem(key: string) {
      if (fake.throws) throw new Error('access denied');
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (fake.throws) throw new Error('quota exceeded');
      map.set(key, value);
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: fake };
  return fake;
}

describe('the stored user offset', () => {
  let store: ReturnType<typeof storage>;
  beforeEach(() => {
    store = storage();
  });

  it('round-trips a value', () => {
    saveUserOffset(-180);
    assert.equal(loadUserOffset(), -180);
  });

  it('reads as no preference when nothing was ever stored', () => {
    assert.equal(loadUserOffset(), 0);
  });

  it('ignores a value that is not a number', () => {
    // Anything can be in here: an older build, or someone with devtools.
    // A NaN reaching the scheduler would schedule the start at NaN.
    store.setItem('rave.userOffsetMs', 'later');
    assert.equal(loadUserOffset(), 0);
  });

  it('clamps a value from outside the range rather than discarding it', () => {
    store.setItem('rave.userOffsetMs', '5000');
    assert.equal(loadUserOffset(), 500);
    store.setItem('rave.userOffsetMs', '-5000');
    assert.equal(loadUserOffset(), -500);
  });

  it('survives storage that refuses to be read', () => {
    // Private mode throws on access rather than returning null.
    store.throws = true;
    assert.equal(loadUserOffset(), 0);
  });

  it('survives storage that refuses to be written', () => {
    store.throws = true;
    assert.doesNotThrow(() => saveUserOffset(-100));
  });
});
