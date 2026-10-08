/**
 * The two colours that best stand for a picture, to light the stage with.
 *
 * Counts pixels into twelve hue buckets, weighted by how colourful they are,
 * so a mostly grey sleeve with one red stripe is judged by the stripe, and
 * takes the two heaviest buckets. A picture with no colour in it gives none,
 * and the caller falls back to the generated look.
 */

const BUCKETS = 12;
/** Below this the pixel is grey, however it was dyed. */
const MIN_CHROMA = 0.12;

export function paletteOf(rgba: Uint8ClampedArray): [string, string] | undefined {
  const weight = new Float64Array(BUCKETS);
  const sum = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = (max - min) / 255;
    // Near black and near white carry no colour whatever their chroma says.
    if (chroma < MIN_CHROMA || max < 40 || min > 235) continue;
    let hue: number;
    if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    const bucket = Math.floor(((hue < 0 ? hue + 6 : hue) / 6) * BUCKETS) % BUCKETS;
    weight[bucket]! += chroma;
    sum[bucket]![0]! += r * chroma;
    sum[bucket]![1]! += g * chroma;
    sum[bucket]![2]! += b * chroma;
  }
  const ranked = [...weight.keys()].filter((k) => weight[k]! > 0).sort((a, b) => weight[b]! - weight[a]!);
  if (ranked.length === 0) return undefined;
  const colour = (k: number) => {
    const w = weight[k]!;
    return `rgb(${Math.round(sum[k]![0]! / w)} ${Math.round(sum[k]![1]! / w)} ${Math.round(sum[k]![2]! / w)})`;
  };
  const first = ranked[0]!;
  return [colour(first), colour(ranked[1] ?? first)];
}
