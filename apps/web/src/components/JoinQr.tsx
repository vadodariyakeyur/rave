'use client';

import qrcode from 'qrcode-generator';

/**
 * The room's join link, as something a phone can point a camera at.
 *
 * Phase 1 is same-wifi and joining is a tap, so the realistic path onto a
 * second device is retyping a six-character code off someone else's screen.
 * This removes that step: scan, land on the pre-join screen, tap Join.
 *
 * Hidden once the room locks, because the link stops working at that point —
 * the server refuses joins after the creator starts, and a QR that leads to
 * "that room has already started playing" is worse than no QR.
 */
export function JoinQr({ url }: { url: string }) {
  const { path, size } = qrPath(url);
  return (
    <figure className="flex flex-col items-center gap-2">
      {/* The SVG is built from the module grid rather than the library's own
          createSvgTag, which returns black-on-white markup that would need
          dangerouslySetInnerHTML and would sit as a white slab in a dark-only
          UI. Drawing it here costs one path element and themes properly. */}
      <svg
        viewBox={`0 0 ${size} ${size}`}
        // Wider than it looks necessary: a phone camera needs roughly an inch
        // of physical target to lock focus, and a smaller code means the
        // scanner hunts. shape-rendering keeps module edges from blurring
        // into each other when the browser scales the grid up.
        className="h-44 w-44 rounded-md bg-white p-2 [shape-rendering:crispEdges]"
        role="img"
        aria-label={`QR code to join this room at ${url}`}
      >
        <path d={path} fill="#000" />
      </svg>
      <figcaption className="text-center text-xs text-[var(--color-muted-foreground)]">
        Scan to join
      </figcaption>
    </figure>
  );
}

/**
 * The dark modules of `url`'s QR code, as one SVG path, plus the grid size.
 *
 * One path rather than a rect per module: a URL at this length is a 33x33
 * grid, so roughly five hundred dark squares, and five hundred DOM nodes to
 * render a static image is the kind of thing that shows up as jank on the
 * phone it exists to serve.
 *
 * Type 0 is automatic sizing — the smallest version the data fits in. Error
 * correction M rather than L: the code is being read off a glowing screen at
 * an angle, often with a reflection across part of it, and M buys that back
 * for a slightly denser grid.
 */
export function qrPath(url: string): { path: string; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col},${row}h1v1h-1z`;
    }
  }
  return { path, size };
}
