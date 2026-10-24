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

const SHAPES = 13;
/** The first of them are the plain ones; a track cover is small and sticks to those. */
const BASIC_SHAPES = 7;

/** One shape in the unit cell at (x, y). Turned about the cell's centre, so they need not fill it. */
function shapeOf(kind: number, x: number, y: number): string {
  const dot = (cx: number, cy: number, r: number) =>
    `M${x + cx - r} ${y + cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
  return [
    `M${x} ${y}h1v1h-1z`, // square
    dot(0.5, 0.5, 0.5), // circle
    `M${x} ${y}h1a1 1 0 0 1-1 1z`, // quarter disc
    `M${x} ${y}h1v1z`, // triangle
    `M${x} ${y}h1v0.5h-1zM${x} ${y + 0.5}h0.5v0.5h-0.5z`, // split block
    dot(0.5, 0.5, 0.5) + dot(0.5, 0.5, 0.22), // ring
    `M${x + 0.5} ${y}l0.5 0.5l-0.5 0.5l-0.5-0.5z`, // diamond
    `M${x + 0.33} ${y}h0.34v0.33h0.33v0.34h-0.33v0.33h-0.34v-0.33h-0.33v-0.34h0.33z`, // plus
    `M${x} ${y + 1}a0.5 0.5 0 0 1 1 0z`, // half disc
    `M${x} ${y}h0.2v1h-0.2zM${x + 0.4} ${y}h0.2v1h-0.2zM${x + 0.8} ${y}h0.2v1h-0.2z`, // stripes
    `M${x + 0.5} ${y + 0.5}V${y}A0.5 0.5 0 1 1 ${x} ${y + 0.5}z`, // three-quarter pie
    `M${x} ${y + 1}v-0.5a0.5 0.5 0 0 1 1 0v0.5z`, // arch
    dot(0.27, 0.27, 0.2) + dot(0.73, 0.73, 0.2), // two dots
  ][kind]!;
}

/**
 * A board of hard-edged tiles (squares, circles, rings, stripes and more) in the title's two hues on near-black. Bauhaus by way of
 * NeoPOP: no gradients, and every title gets its own pattern.
 */
function tilesOf(seed: string, hue: number, hue2: number, n: number): string {
  const count = n > 4 ? SHAPES : BASIC_SHAPES;
  const dark = Math.round(count / 5);
  const colours = [`oklch(0.78 0.17 ${hue})`, `oklch(0.7 0.19 ${hue2})`];
  let shapes = '';
  for (let i = 0; i < n * n; i++) {
    const h = hash(`${seed}/${i}`);
    const kind = h % (count + dark);
    if (kind >= count) continue; // a few cells are left dark
    const x = i % n;
    const y = Math.floor(i / n);
    const rotate = ((h >>> 4) % 4) * 90;
    const fill = colours[(h >>> 8) % 2];
    const d = shapeOf(kind, x, y);
    const delay = -((h >>> 12) % 60) / 10; // negative, so every tile is already mid-turn
    shapes += `<path d="${d}" fill="${fill}" fill-rule="evenodd" style="--a:${rotate}deg;--b:${rotate + 90}deg;transform-origin:${x + 0.5}px ${y + 0.5}px;animation-delay:${delay}s"/>`;
  }
  // Tiles turn a quarter, rest, and turn back, each on its own beat. The query is
  // evaluated for the image itself, so reduced motion leaves the board still.
  const motion =
    `<style>path{transform-box:view-box;transform:rotate(var(--a))}` +
    `@media(prefers-reduced-motion:no-preference){path{animation:t 6s ease-in-out infinite alternate}}` +
    `@keyframes t{0%,35%{transform:rotate(var(--a))}65%,100%{transform:rotate(var(--b))}}</style>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid slice">` +
    `${motion}<rect width="${n}" height="${n}" fill="oklch(0.2 0.05 ${hue})"/>${shapes}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / cover`;
}

/** `grid` is tiles per side: 4 for a cover, more for a backdrop that wants no visible repeat. */
export function coverOf(seed: string, grid = 4): CoverStyle {
  const { hue, hue2 } = lookOf(seed);
  return {
    background: tilesOf(seed.trim().toLowerCase(), hue, hue2, grid),
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
