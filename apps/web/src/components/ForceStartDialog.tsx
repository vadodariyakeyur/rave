'use client';

import { useEffect, useRef } from 'react';
import type { Peer } from '@rave/protocol';
import { Button } from '@/components/ui/button';

/**
 * Native <dialog>, not a vendored shadcn one: the platform already does the
 * modal backdrop, the focus trap and Escape-to-close, and this is the only
 * dialog in the product.
 *
 * It names the peers rather than counting them. "2 peers are not ready" does
 * not tell the creator whether to wait; "Sam's phone" does.
 */
export function ForceStartDialog({
  notReady,
  onCancel,
  onConfirm,
}: {
  /**
   * The peers to name, snapshotted when the dialog opened — undefined when it
   * is closed. One prop rather than `open` plus a list, because a dialog that
   * is open with nothing to name is not a state this can be in.
   */
  notReady: readonly Peer[] | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // showModal() is imperative and cannot be expressed as an attribute: the
  // `open` attribute alone renders a non-modal dialog with no backdrop.
  const open = notReady !== undefined;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Escape and the backdrop both fire 'close'; routing them through the
      // same callback keeps React's idea of open from drifting from the DOM's.
      onClose={onCancel}
      className="m-auto max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-[var(--color-card-foreground)] backdrop:bg-black/60"
    >
      <h2 className="text-base font-medium">Start without everyone?</h2>
      <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
        {notReady?.length === 1 ? 'This device has' : 'These devices have'} not finished
        downloading and will be dropped from the room:
      </p>
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {notReady?.map((peer) => (
          <li key={peer.peerId}>{peer.displayName}</li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Keep waiting
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm}>
          Start anyway
        </Button>
      </div>
    </dialog>
  );
}
