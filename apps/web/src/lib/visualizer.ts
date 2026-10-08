/**
 * The maths behind the ring of bars around the cover, kept apart from the
 * canvas so it can be tested without one.
 *
 * Three jobs. Group the analyser's frequency bins into bars the way ears hear
 * them, with fine steps at the bass and coarse ones at the treble; scale each
 * against what its own band has recently been doing, so a quiet record and a
 * loud one both fill the ring and every bar moves with its own part of the
 * music; and keep every bar from jumping. The last is not polish: bars that follow the beat
 * frame for frame can flash large areas of the screen several times a second,
 * which is what WCAG 2.3.1 exists to prevent, so a bar may only rise so far
 * per frame and falls more slowly than it rose.
 */

/** Bars in the full ring. Even, so the two halves mirror. */
export const RING_BARS = 48;

/** Share of the bins used. The very top of the spectrum is mostly air. */
const USED_SHARE = 0.75;

/**
 * How lopsided the grouping is. At 1 every bar gets the same number of bins,
 * and nearly the whole ring is treble; higher gives the bass more bars.
 */
const BAND_CURVE = 1.4;

/** Treble is quiet in nearly all music; this lifts it, up to this much extra at the top bar. */
const TILT = 1.5;

/** Largest share of the gap to the target a bar closes in one frame, rising. */
const ATTACK = 0.5;

/** And falling: slower, so the ring settles like something with weight. */
const DECAY = 0.14;

/** What "loud" is measured against never drops below this, so silence is not amplified into noise. */
const GAIN_FLOOR = 0.4;

/** Per frame, how slowly a remembered loudest level fades: a few seconds to halve at 60 fps. */
const GAIN_FALL = 0.99;

/**
 * How much each bar is judged against its own band's recent loudest, and how
 * much against the whole spectrum's. Mostly its own: with only the whole
 * spectrum to go on, the bass sets the scale and every other bar sits on a
 * flat low shelf whatever the music does.
 */
const OWN_BAND = 0.8;

/** Softens the middle so most of the ring takes part; the peaks still stand out. */
const CONTRAST = 1.5;

export interface Ring {
  /** Each bar, 0 to 1, mirrored: bar i equals bar N-1-i. Also last frame's, which is what it is smoothed from. */
  bars: Float32Array;
  /** The loudest band lately, 0 to 1. */
  peak: number;
  /** The loudest each band has been lately, for the half ring. */
  bandPeaks: Float32Array;
}

export function createRing(): Ring {
  return { bars: new Float32Array(RING_BARS), peak: 0, bandPeaks: new Float32Array(RING_BARS / 2) };
}

/** Move the ring one frame towards what `bins` (0 to 255, as the analyser gives them) say. */
export function stepRing(bins: Uint8Array, ring: Ring): void {
  const { bars, bandPeaks } = ring;
  const half = bars.length / 2;
  const used = Math.max(1, Math.floor(bins.length * USED_SHARE));

  const level = new Float32Array(half);
  let loudest = 0;
  for (let i = 0; i < half; i++) {
    const from = Math.floor(used * (i / half) ** BAND_CURVE);
    const to = Math.max(from + 1, Math.floor(used * ((i + 1) / half) ** BAND_CURVE));
    let sum = 0;
    for (let j = from; j < to; j++) sum += bins[j] ?? 0;
    level[i] = (sum / (to - from) / 255) * (1 + TILT * (i / half));
    loudest = Math.max(loudest, level[i]!);
  }
  ring.peak = Math.max(loudest, ring.peak * GAIN_FALL);

  for (let i = 0; i < half; i++) {
    bandPeaks[i] = Math.max(level[i]!, bandPeaks[i]! * GAIN_FALL);
    const scale = Math.max(bandPeaks[i]! * OWN_BAND + ring.peak * (1 - OWN_BAND), GAIN_FLOOR);
    const target = Math.min(1, level[i]! / scale) ** CONTRAST;
    const current = bars[i] ?? 0;
    const next = current + (target - current) * (target > current ? ATTACK : DECAY);
    bars[i] = next;
    bars[bars.length - 1 - i] = next;
  }
}
