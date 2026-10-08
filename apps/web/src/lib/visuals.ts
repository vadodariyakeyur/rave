'use client';

const KEY = 'rave.visuals';

/**
 * Whether the ring of bars moves, remembered on this device.
 *
 * Off by default for anyone who has asked their system for less motion: a
 * canvas loop is not covered by prefers-reduced-motion, so the preference
 * has to be read here and the toggle left in sight. Storage is best-effort,
 * as in offset.ts.
 */
export function loadVisuals(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null) return stored === 'on';
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // No window (the server render) or no storage (private mode): on.
    return true;
  }
}

export function saveVisuals(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Not remembered; it still works for this session.
  }
}
