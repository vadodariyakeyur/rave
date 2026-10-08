import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { avatarContrast, avatarOf, coverOf, hash, initialsOf, lookOf } from './cover.ts';

describe('covers', () => {
  it('are the same for the same title, whatever its case or padding', () => {
    assert.deepEqual(coverOf('Boom Shaka'), coverOf('  boom shaka '));
    assert.equal(hash('a'), hash('a'));
  });

  it('differ between titles, and stay inside their ranges', () => {
    const backgrounds = new Set<string>();
    for (const title of ['a.mp3', 'b.mp3', 'Boom Shaka', 'long.wav', 'second.wav', '密码', '']) {
      const look = lookOf(title);
      assert.ok(look.hue >= 0 && look.hue < 360 && look.hue2 >= 0 && look.hue2 < 360);
      assert.ok(look.x >= 15 && look.x < 85 && look.y >= 15 && look.y < 85);
      // Related hues, never a near-match.
      const gap = Math.abs(look.hue - look.hue2);
      assert.ok(Math.min(gap, 360 - gap) >= 70, `${title}: hues ${look.hue} and ${look.hue2}`);
      backgrounds.add(coverOf(title).background);
    }
    assert.equal(backgrounds.size, 7);
  });
});

describe('avatars', () => {
  it('keep their text readable (AA) for every name tried', () => {
    const names = ['Keyur', 'Sam', 'Ada', 'Host', 'ppp', 'kkk', 'Zoë', '密码', 'A', ...Array.from({ length: 400 }, (_, i) => `person ${i}`)];
    for (const name of names) {
      assert.ok(avatarContrast(name) >= 4.5, `${name}: ${avatarContrast(name).toFixed(2)}`);
    }
  });

  it('are the same for the same name and different across names', () => {
    assert.deepEqual(avatarOf('Sam'), avatarOf('sam '));
    assert.notEqual(avatarOf('Sam').background, avatarOf('Ada').background);
  });

  it('take initials from the first and last word, and never come out empty', () => {
    assert.equal(initialsOf('Keyur'), 'K');
    assert.equal(initialsOf('ada lovelace'), 'AL');
    assert.equal(initialsOf('  mary   jane   watson '), 'MW');
    assert.equal(initialsOf('😀 party'), '😀P');
    assert.equal(initialsOf('   '), '?');
  });
});
