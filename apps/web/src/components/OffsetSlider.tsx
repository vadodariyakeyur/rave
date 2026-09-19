'use client';

import { useId } from 'react';

import { OFFSET_RANGE_MS } from '@/lib/offset';

/**
 * The listener's own latency correction.
 *
 * Bluetooth output is 100-300ms late and the browser has no API that says
 * so — no amount of clock work reaches it. Dragging until it sounds right
 * is the only mechanism available, which is why this is not optional and
 * why the change has to be audible while the drag is happening.
 *
 * A native range input rather than a component: it is already keyboard
 * operable, already announced correctly, and already draggable on touch.
 */
export function OffsetSlider({
  valueMs,
  onChange,
}: {
  valueMs: number;
  onChange: (valueMs: number) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm">
          My audio delay
        </label>
        <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
          {valueMs > 0 ? '+' : ''}
          {valueMs}ms
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={-OFFSET_RANGE_MS}
        max={OFFSET_RANGE_MS}
        step={10}
        value={valueMs}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[var(--color-primary)]"
      />
      <p className="text-xs text-[var(--color-muted-foreground)]">
        On Bluetooth headphones? Drag until this device sounds in time with the others.
      </p>
    </div>
  );
}
