'use client';

import type { Art } from './artwork';
import { paletteOf } from './palette';

/** A track's picture as the screen uses it. */
export interface TrackArt {
  /** An object URL for a small copy of the picture. Revoke it when the track goes. */
  url: string;
  /** Two colours from the picture, to light the stage. Absent for a greyscale sleeve. */
  glow?: [string, string];
}

/** Big enough for the stage cover on a high-density screen, small enough to be cheap to hold and decode. */
const SIZE = 512;

/** For the palette. Sixteen by sixteen is plenty to tell what colour a sleeve is. */
const SAMPLE = 16;

const surface = (size: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
};

/**
 * Shrink an embedded picture and take its colours.
 *
 * Embedded art is often 3000 pixels square, and every thumbnail in the queue
 * would otherwise decode a copy of that at full size. One square 512px JPEG
 * per track is held instead. Undefined when the browser cannot read the
 * picture, which is no worse than it having none.
 */
export async function makeArt(art: Art): Promise<TrackArt | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([art.data as BlobPart], { type: art.mime }));
    // A centred square, so a wide sleeve is cropped and not stretched.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const small = surface(SIZE);
    small.getContext('2d')!.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const tiny = surface(SAMPLE);
    const tinyContext = tiny.getContext('2d', { willReadFrequently: true })!;
    tinyContext.drawImage(bitmap, sx, sy, side, side, 0, 0, SAMPLE, SAMPLE);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => small.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return undefined;
    return {
      url: URL.createObjectURL(blob),
      glow: paletteOf(tinyContext.getImageData(0, 0, SAMPLE, SAMPLE).data),
    };
  } catch {
    return undefined;
  }
}
