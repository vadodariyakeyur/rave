import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, parseOklch } from '../lib/color.ts';

/**
 * The theme is a file anyone can paste over, so what this guards is the pairs
 * the screens rely on: if a new theme breaks one, this says which.
 */
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline'));
const token = (name: string) => {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(dark);
  assert.ok(match, `--${name} missing from .dark`);
  return parseOklch(match[1]!);
};

describe('the dark theme', () => {
  const text: [string, string][] = [
    ['foreground', 'background'],
    ['card-foreground', 'card'],
    ['muted-foreground', 'card'],
    ['muted-foreground', 'background'],
    ['primary-foreground', 'primary'],
    ['secondary-foreground', 'secondary'],
    ['destructive', 'card'],
    ['destructive', 'background'],
    ['accent-foreground', 'accent'],
    ['foreground', 'popover'],
  ];
  for (const [fg, bg] of text) {
    it(`keeps ${fg} readable on ${bg} (AA, 4.5)`, () => {
      assert.ok(contrast(token(fg), token(bg)) >= 4.5, `${contrast(token(fg), token(bg)).toFixed(2)}`);
    });
  }

  const ui: [string, string][] = [
    // Blurple is a fill; drawn on a grey, the ring tone stands in for it.
    ['ring', 'background'],
    ['chart-1', 'card'],
    ['ring', 'card'],
    ['chart-1', 'background'],
  ];
  for (const [fg, bg] of ui) {
    it(`keeps ${fg} visible on ${bg} (3, for icons and rings)`, () => {
      assert.ok(contrast(token(fg), token(bg)) >= 3, `${contrast(token(fg), token(bg)).toFixed(2)}`);
    });
  }
});
