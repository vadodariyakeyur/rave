/**
 * Just enough colour maths to know whether text is readable on a colour that
 * was generated rather than designed: OKLCH to sRGB, and WCAG contrast.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Linear sRGB, 0 to 1 each, clamped: what the display can actually show. */
export function toLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** WCAG relative luminance. */
export function luminance(color: Oklch): number {
  const [r, g, b] = toLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. 4.5 is AA for text, 3 for large text and UI. */
export function contrast(a: Oklch, b: Oklch): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parses `oklch(L C H)` as written in theme.css. */
export function parseOklch(css: string): Oklch {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
  if (!match) throw new Error(`not an oklch colour: ${css}`);
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}
