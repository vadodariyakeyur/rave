'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A panel that rises from the bottom: where the playlist and the people live.
 * A native dialog, so the focus trap, Escape and focus return are the browser's.
 */
export function Sheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
      className="flat mt-auto mb-0 max-h-[85dvh] w-full max-w-160 animate-rise self-end justify-self-center overflow-y-auto p-5 text-card-foreground backdrop:bg-black/50"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-[0.8125rem] font-extrabold tracking-wide uppercase">
          {title}
        </h2>
        <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </dialog>
  );
}
