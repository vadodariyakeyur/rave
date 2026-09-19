import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { progressPercent, formatDuration } from './TrackProgress.tsx';

describe('progressPercent', () => {
  it('reports how far through the track it is', () => {
    assert.equal(progressPercent(30, 120), 25);
  });

  it('clamps past the end', () => {
    // Position comes off the audio clock, which can read a hair past the
    // buffer length on the last tick; a bar wider than its track spills
    // out of the rounded corners.
    assert.equal(progressPercent(120.4, 120), 100);
  });

  it('clamps before the start', () => {
    assert.equal(progressPercent(-1, 120), 0);
  });

  it('returns zero rather than NaN for a zero-length track', () => {
    // NaN reaches the DOM as an invalid width, not an error, so this would
    // be an invisible bar rather than a crash.
    assert.equal(progressPercent(0, 0), 0);
  });
});

describe('formatDuration', () => {
  it('pads the seconds', () => {
    assert.equal(formatDuration(65), '1:05');
  });

  it('floors rather than rounds', () => {
    // At 0.9s in, the honest reading is 0:00. Rounding would also show a
    // track reaching its full length a half-second before it ends.
    assert.equal(formatDuration(0.9), '0:00');
    assert.equal(formatDuration(119.6), '1:59');
  });

  it('does not render a negative time', () => {
    assert.equal(formatDuration(-0.2), '0:00');
  });
});
