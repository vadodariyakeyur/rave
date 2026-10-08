'use client';

import { useEffect, useRef } from 'react';
import type { LiveRoom } from '@/lib/room';
import { ANALYSER_BINS } from '@/lib/player';
import { RING_BARS, createRing, stepRing } from '@/lib/visualizer';

/**
 * The ring of bars around the cover, drawn from what this device is playing.
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
    if (!el || !context || !active) return;

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
      // The cover fills the middle 70%; the bars grow in the rest.
      const inner = size * 0.35 + 6;
      const reach = size / 2 - inner - 2;
      context.strokeStyle = color;
      context.lineCap = 'round';
      context.lineWidth = Math.max(2.5, (2 * Math.PI * inner) / RING_BARS / 2);
      for (let i = 0; i < RING_BARS; i++) {
        const angle = (i / RING_BARS) * 2 * Math.PI - Math.PI / 2;
        const length = 2 + ring.bars[i]! * reach;
        context.beginPath();
        context.moveTo(width / 2 + Math.cos(angle) * inner, height / 2 + Math.sin(angle) * inner);
        context.lineTo(
          width / 2 + Math.cos(angle) * (inner + length),
          height / 2 + Math.sin(angle) * (inner + length),
        );
        context.stroke();
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
