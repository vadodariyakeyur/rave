'use client';

import type { PeerConnectionState } from '@/lib/mesh';
import type { Estimate } from '@/lib/clock';

/**
 * An instrument, not UI.
 *
 * Deliberately unstyled: fixed-position monospace, no shadcn, no animation.
 * It updates several times a second, and animated components add re-render
 * churn and visual noise to exactly the measurement you are trying to read.
 *
 * A latency product you cannot measure is a latency product you cannot fix.
 */
export function DebugOverlay({
  estimate,
  connections,
  selfPeerId,
  isCreator,
}: {
  /** Undefined on the creator: it is the clock, so it has no offset to itself. */
  estimate: Estimate | undefined;
  connections: ReadonlyMap<string, PeerConnectionState>;
  selfPeerId: string;
  isCreator: boolean;
}) {
  return (
    <pre
      // Above the room, out of the way of the Play button, and never
      // swallowing a tap meant for what is underneath.
      className="pointer-events-none fixed right-0 top-0 z-50 m-2 max-w-[60vw] overflow-hidden bg-black/80 p-2 text-[10px] leading-tight text-green-400"
    >
      {[
        `self    ${selfPeerId.slice(0, 8)}${isCreator ? ' (clock master)' : ''}`,
        isCreator ? 'offset  — (this device is the reference)' : `offset  ${format(estimate)}`,
        isCreator ? '' : `rtt     ${rtts(estimate)}`,
        // Zero samples with an offset still showing means the last round
        // landed nothing: the reading on screen is the previous one.
        isCreator ? '' : `samples ${estimate?.sampleCount ?? 0}${stale(estimate) ? ' (stale)' : ''}`,
        '',
        ...[...connections].map(([peerId, state]) => `peer    ${peerId.slice(0, 8)} ${state}`),
      ]
        .filter((line) => line !== '')
        .join('\n')}
    </pre>
  );
}

/**
 * One decimal place. The target is ±20ms, so tenths is the finest reading
 * that means anything and more digits just flicker.
 */
function format(estimate: Estimate | undefined): string {
  if (estimate?.offsetMs === undefined) return 'measuring…';
  return `${estimate.offsetMs >= 0 ? '+' : ''}${estimate.offsetMs.toFixed(1)}ms`;
}

/** An offset with nothing behind it: held over from a round that landed. */
function stale(estimate: Estimate | undefined): boolean {
  return estimate?.offsetMs !== undefined && estimate.sampleCount === 0;
}

/** The kept samples, best first — the spread is what says whether to trust it. */
function rtts(estimate: Estimate | undefined): string {
  if (!estimate || estimate.rttsMs.length === 0) return '—';
  return estimate.rttsMs.map((rtt) => rtt.toFixed(1)).join(' ');
}
