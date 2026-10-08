'use client';

import { useRef } from 'react';
import { Copy, Share2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JoinQr } from '@/components/JoinQr';

/**
 * The way into the room: a button that opens its QR code and link.
 *
 * A native <dialog> rather than a component: showModal() already traps focus,
 * closes on Escape and returns focus to the button, which is all a dialog
 * has to do here.
 */
export function ShareDialog({ url, hasPasscode }: { url: string; hasPasscode: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      // Clipboard is refused outside a secure context or without permission.
      toast.error('Could not copy. Select the link and copy it by hand.');
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Share this room"
        onClick={() => dialog.current?.showModal()}
      >
        <Share2 />
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="share-title"
        // A click on the backdrop lands on the dialog itself, not on its content.
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
        className="glass fixed m-auto w-[calc(100%-2.5rem)] max-w-110 animate-pop rounded-[28px] p-6 text-card-foreground backdrop:bg-black/50"
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex w-full items-center justify-between">
            <h2 id="share-title" className="text-xl font-bold">
              Share this room
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={() => dialog.current?.close()}
            >
              <X />
            </Button>
          </div>
          <JoinQr url={url} />
          <div className="flex w-full gap-2">
            <Input readOnly value={url} aria-label="Room link" onFocus={(e) => e.target.select()} />
            <Button type="button" size="icon" aria-label="Copy link" onClick={() => void copy()}>
              <Copy />
            </Button>
          </div>
          {hasPasscode && (
            <p className="text-center text-sm text-muted-foreground">
              This link includes the passcode, so anyone who has it can join.
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}
