'use client';

import { OFFSET_RANGE_MS } from '@/components/OffsetSlider';

const KEY = 'rave.userOffsetMs';

/**
 * The listener's latency correction, remembered across sessions.
 *
 * Per-device and not per-room: it corrects this device's output hardware,
 * which is the same headphones tomorrow as today. Making someone recalibrate
 * their Bluetooth lag every time they join is making them do the same work
 * twice.
 *
 * Storage is best-effort throughout. It throws in private mode and returns
 * whatever a previous version — or a user with devtools open — left behind,
 * so a bad value must read as "no preference", never as a start time.
 */
export function loadUserOffset(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return 0;
    const value = Number(raw);
    // Clamp rather than reject: a value outside the range is still a real
    // preference, just one from a build with a wider slider.
    if (!Number.isFinite(value)) return 0;
    return Math.max(-OFFSET_RANGE_MS, Math.min(OFFSET_RANGE_MS, Math.round(value)));
  } catch {
    return 0;
  }
}

export function saveUserOffset(valueMs: number): void {
  try {
    window.localStorage.setItem(KEY, String(valueMs));
  } catch {
    // Private mode, or a full quota. The slider still works for this
    // session; it just will not be remembered.
  }
}
