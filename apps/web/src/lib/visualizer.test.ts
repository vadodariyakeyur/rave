import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RING_BARS, createRing, stepRing } from './visualizer.ts';

const BINS = 128;
const flat = (value: number) => new Uint8Array(BINS).fill(value);
/** A spectrum that is loud in the bass and falls away, like most music. */
const bassy = () => Uint8Array.from({ length: BINS }, (_, i) => Math.max(0, Math.round(230 - i * 1.5)));
const run = (bins: Uint8Array, frames: number, ring = createRing()) => {
  for (let f = 0; f < frames; f++) stepRing(bins, ring);
  return ring;
};

describe('stepRing', () => {
  it('stays flat for silence', () => {
    const { bars } = run(flat(0), 10);
    assert.ok(bars.every((b) => b === 0));
  });

  it('does not turn faint noise into a full ring', () => {
    const { bars } = run(flat(6), 60);
    assert.ok(bars.every((b) => b < 0.1), `tallest ${Math.max(...bars)}`);
  });

  it('never rises faster than the attack, so a sudden loud frame cannot flash the ring', () => {
    const ring = createRing();
    stepRing(flat(255), ring);
    assert.ok(ring.bars.every((b) => b > 0 && b <= 0.5 + 1e-6), `first frame: ${ring.bars[0]}`);
    let previous = ring.bars[0]!;
    for (let frame = 0; frame < 5; frame++) {
      stepRing(flat(255), ring);
      assert.ok(ring.bars[0]! - previous <= (1 - previous) * 0.5 + 1e-6);
      previous = ring.bars[0]!;
    }
  });

  it('falls more slowly than it rose', () => {
    const rose = run(flat(255), 1).bars[0]!;
    const ring = run(flat(255), 40);
    const before = ring.bars[0]!;
    stepRing(flat(0), ring);
    assert.ok(before - ring.bars[0]! < rose, `fell ${before - ring.bars[0]!}, rose ${rose}`);
  });

  it('settles back to nothing once the sound stops', () => {
    const ring = run(flat(255), 40);
    for (let frame = 0; frame < 600; frame++) stepRing(flat(0), ring);
    assert.ok(ring.bars.every((b) => b < 0.001));
  });

  it('lifts a band when it gets louder than it has lately been, and leaves the others alone', () => {
    // A track the ring has been listening to: steady bass, and hats now and then.
    const hat = Uint8Array.from({ length: BINS }, (_, i) => (i > BINS * 0.55 ? 250 : 110));
    const between = Uint8Array.from({ length: BINS }, (_, i) => (i > BINS * 0.55 ? 40 : 110));
    const ring = createRing();
    for (let bar = 0; bar < 12; bar++) {
      for (let f = 0; f < 3; f++) stepRing(hat, ring);
      for (let f = 0; f < 12; f++) stepRing(between, ring);
    }
    const treble = RING_BARS / 2 - 2;
    const quietTreble = ring.bars[treble]!;
    const bassBefore = ring.bars[1]!;
    assert.ok(quietTreble < 0.4, `between hats the treble is low: ${quietTreble}`);

    for (let f = 0; f < 4; f++) stepRing(hat, ring);
    assert.ok(ring.bars[treble]! > quietTreble + 0.3, `the hat lifted the treble: ${quietTreble} to ${ring.bars[treble]}`);
    assert.ok(Math.abs(ring.bars[1]! - bassBefore) < 0.1, `the bass held: ${bassBefore} to ${ring.bars[1]}`);
  });

  it('moves with the beat: a quiet stretch dips the bars and the next hit lifts them again', () => {
    const ring = run(bassy(), 120);
    const loud = ring.bars[0]!;
    const quiet = Uint8Array.from(bassy(), (v) => Math.round(v * 0.3));
    for (let f = 0; f < 12; f++) stepRing(quiet, ring);
    const dipped = ring.bars[0]!;
    assert.ok(dipped < loud * 0.6, `dipped ${dipped} from ${loud}`);
    for (let f = 0; f < 6; f++) stepRing(bassy(), ring);
    assert.ok(ring.bars[0]! > dipped + 0.25);
  });

  it('fills the whole ring for music, not just one end', () => {
    const ring = run(bassy(), 200);
    const taken = [...ring.bars.slice(0, RING_BARS / 2)].filter((b) => b > 0.3).length;
    assert.ok(taken >= RING_BARS / 2 - 2, `${taken} of ${RING_BARS / 2} bars above 0.3`);
  });

  it('mirrors the two halves, and keeps every bar within 0 and 1', () => {
    const ring = createRing();
    const uneven = Uint8Array.from({ length: BINS }, (_, i) => (i * 37) % 256);
    for (let frame = 0; frame < 40; frame++) stepRing(uneven, ring);
    for (let i = 0; i < RING_BARS; i++) {
      assert.equal(ring.bars[i], ring.bars[RING_BARS - 1 - i]);
      assert.ok(ring.bars[i]! >= 0 && ring.bars[i]! <= 1);
    }
  });

  it('copes with no bins at all', () => {
    assert.doesNotThrow(() => stepRing(new Uint8Array(0), createRing()));
  });
});
