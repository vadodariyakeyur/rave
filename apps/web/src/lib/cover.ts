import { contrast, type Oklch } from './color';

/**
 * Covers and avatars made from a string, so the same title or name always
 * looks the same on every device and nothing has to be stored or sent.
 *
 * Lightness and chroma are fixed and only hue varies: in OKLCH that keeps
 * every cover and avatar the same visual weight, where HSL would make some
 * hues glare and others sink. These colours are content, not the theme: they
 * stay as they are when theme.css is swapped.
 */

/** FNV-1a, 32 bit. Small, fast, and plenty for choosing a hue. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The numbers a seed turns into. Each reads a different slice of the hash. */
export interface Look {
  hue: number;
  hue2: number;
  angle: number;
  x: number;
  y: number;
}

export function lookOf(seed: string): Look {
  const h = hash(seed.trim().toLowerCase());
  const hue = h % 360;
  return {
    hue,
    // 70 to 150 degrees away: related, never a muddy near-match.
    hue2: (hue + 70 + ((h >>> 9) % 80)) % 360,
    angle: (h >>> 13) % 360,
    x: 15 + ((h >>> 17) % 70),
    y: 15 + ((h >>> 22) % 70),
  };
}

export interface CoverStyle {
  background: string;
  /** Two colours for the glow behind the stage. */
  glow: [string, string];
}

export function coverOf(seed: string): CoverStyle {
  const { hue, hue2, angle, x, y } = lookOf(seed);
  return {
    background: [
      `radial-gradient(circle at ${x}% ${y}%, oklch(0.78 0.16 ${hue2}) 0, transparent 58%)`,
      `conic-gradient(from ${angle}deg at ${100 - x}% ${100 - y}%, oklch(0.56 0.2 ${hue}), oklch(0.42 0.17 ${hue2}), oklch(0.62 0.19 ${hue}))`,
    ].join(', '),
    glow: [`oklch(0.62 0.2 ${hue})`, `oklch(0.64 0.2 ${hue2})`],
  };
}

const AVATAR_LIGHT = 0.76;
const AVATAR_DARK_TEXT = 0.2;

export interface AvatarStyle {
  background: string;
  color: string;
  /** The two stops, for checking text against both. */
  stops: [Oklch, Oklch];
  text: Oklch;
}

export function avatarOf(name: string): AvatarStyle {
  const { hue } = lookOf(name);
  const a: Oklch = { l: AVATAR_LIGHT, c: 0.13, h: hue };
  const b: Oklch = { l: AVATAR_LIGHT - 0.07, c: 0.15, h: (hue + 40) % 360 };
  const text: Oklch = { l: AVATAR_DARK_TEXT, c: 0.04, h: hue };
  const css = (c: Oklch) => `oklch(${c.l} ${c.c} ${c.h})`;
  return {
    background: `linear-gradient(135deg, ${css(a)}, ${css(b)})`,
    color: css(text),
    stops: [a, b],
    text,
  };
}

/** Up to two letters: first of the first and last words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]!)[0]!;
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : '';
  return (first + last).toUpperCase();
}

/** The worst contrast text has on this avatar. */
export function avatarContrast(name: string): number {
  const { stops, text } = avatarOf(name);
  return Math.min(contrast(text, stops[0]), contrast(text, stops[1]));
}
