'use client';

/**
 * Keeping the creator's tab awake, and telling them when it is not.
 *
 * The creator is the clock master. If their screen locks or they switch
 * apps, the browser throttles the tab, their audio clock stops being the
 * reference everyone measured against, and the room drifts apart with no
 * visible cause. Neither of these prevents that — a wake lock is a request
 * the OS may refuse, and nothing stops someone switching apps — so the
 * warning matters as much as the lock.
 */

/**
 * Request a screen wake lock, reacquiring it after the tab comes back.
 *
 * The lock is released by the browser whenever the document is hidden, and
 * it is not restored on return, so without the visibility handler it holds
 * only until the first app switch.
 */
export function keepAwake(): () => void {
  // Older Safari has no wakeLock at all. Nothing to do, and nothing broken:
  // the visibility warning is the part that always works.
  const api = navigator.wakeLock;
  if (!api) return () => {};

  let sentinel: WakeLockSentinel | undefined;
  let released = false;

  const acquire = async () => {
    if (released || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await api.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = undefined;
      });
    } catch {
      // Denied, or the tab lost focus mid-request. Not worth retrying in a
      // loop: the visibility handler will try again on the next return.
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void acquire();
  };

  void acquire();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisible);
    void sentinel?.release().catch(() => {});
    sentinel = undefined;
  };
}

/** Call back when the tab is hidden, so the creator can be warned on return. */
export function onHidden(warn: () => void): () => void {
  const handler = () => {
    if (document.visibilityState === 'hidden') warn();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
