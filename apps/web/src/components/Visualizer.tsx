'use client';

import { useEffect, useRef } from 'react';
import type { LiveRoom } from '@/lib/room';
import { ANALYSER_BINS } from '@/lib/player';
import { RING_BARS, createRing, stepRing } from '@/lib/visualizer';

/** Bars along each edge of the cover. */
const PER_SIDE = RING_BARS / 4;

/**
 * The frame of blocks around the cover, drawn from what this device is playing.
 *
 * Every device plays the same audio at the same instant, so every device's
 * ring moves together without a word crossing the wire. The loop only exists
 * while `active`: not playing, switched off, or reduced motion is no work at
 * all, and a hidden tab stops it too.
 */
export function Visualizer({
  room,
  active,
  color,
  className,
}: {
  room: LiveRoom;
  active: boolean;
  color: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const context = el?.getContext('2d');
    if (!el || !context || !active || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Allocated once: the loop runs sixty times a second.
    const bins = new Uint8Array(ANALYSER_BINS);
    const ring = createRing();
    let frame = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      // Capped at 2: a 3x phone screen would otherwise fill nine times the pixels.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = el.clientWidth;
      height = el.clientHeight;
      el.width = Math.round(width * ratio);
      el.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (!room.levels(bins)) bins.fill(0);
      stepRing(bins, ring);

      context.clearRect(0, 0, width, height);
      const size = Math.min(width, height);
      // The cover fills the middle 70%; blocks grow out of its four edges in the rest.
      const half = size * 0.35 + 6;
      const reach = size / 2 - half - 2;
      const slot = (2 * half) / PER_SIDE;
      const thick = slot - 3;
      const cx = width / 2;
      const cy = height / 2;
      for (let i = 0; i < RING_BARS; i++) {
        const side = Math.floor(i / PER_SIDE);
        const along = -half + (i % PER_SIDE) * slot + 1.5;
        const length = 2 + ring.bars[i]! * reach;
        // Out along the side's normal: top, right, bottom, left.
        const rects: [number, number, number, number][] = [
          [cx + along, cy - half - length, thick, length],
          [cx + half, cy + along, length, thick],
          [cx - along - thick, cy + half, thick, length],
          [cx - half - length, cy - along - thick, length, thick],
        ];
        const [x, y, w, h] = rects[side]!;
        context.fillStyle = color;
        context.fillRect(x, y, w, h);
        // A bright cap on the outer end, like a plunk's edge.
        context.fillStyle = '#fff';
        const cap = Math.min(3, length);
        if (side === 0) context.fillRect(x, y, w, cap);
        else if (side === 1) context.fillRect(x + w - cap, y, cap, h);
        else if (side === 2) context.fillRect(x, y + h - cap, w, cap);
        else context.fillRect(x, y, cap, h);
      }
    };

    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };

    resize();
    frame = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      context.clearRect(0, 0, width, height);
    };
  }, [room, active, color]);

  return <canvas ref={canvas} aria-hidden className={className} />;
}
