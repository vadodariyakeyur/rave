'use client';

/**
 * The audio file, creator -> peer, over the DataChannel the mesh already
 * opened. Nothing here touches the server: the file is the one thing that
 * must never go through it.
 *
 * A transfer is a JSON header, then raw binary chunks, then nothing. The
 * header carries the total so the receiver can size its buffer once and
 * report a real percentage rather than a spinner.
 */

/** The DataChannel limit that is safe everywhere; larger silently drops on some stacks. */
const CHUNK_BYTES = 16 * 1024;

/**
 * How much may sit unsent before the sender waits for the channel to drain.
 * Without a cap, chunking a 40MB file just moves the whole file into the
 * channel's own buffer and the browser kills the connection.
 */
const HIGH_WATER = 1 * 1024 * 1024;

/**
 * No progress for this long and the peer is stalled.
 *
 * The sender owns this call: it is the one that knows when the buffer last
 * moved, and a wedged channel fires no event to say so. Without it the
 * roster shows 40% forever and the host waits on a device that is not
 * coming back.
 */
export const STALL_MS = 15_000;

/**
 * One wording for a channel that went away mid-transfer, whatever end noticed.
 * Matches DECODE_ERROR in audio.ts: the roster shows these to a person.
 */
export const CLOSED_ERROR = 'The connection closed before the file finished.';

/**
 * What the roster renders for one member's copy of the playlist.
 *
 * 'sent' is deliberately not 'ready': handing the last chunk to the channel
 * says nothing about whether it arrived. It means the creator has nothing
 * more to send them, which is all the creator can know.
 */
export interface Transfer {
  /** Bytes handed over, of all the bytes in the playlist. 0 to 1. */
  progress: number;
  state: 'downloading' | 'sent' | 'stalled';
}

interface Header {
  type: 'file-header';
  /** Which playlist track this is. A channel carries many, one after another. */
  trackId: string;
  fileName: string;
  byteLength: number;
}

export interface Outgoing {
  trackId: string;
  bytes: ArrayBuffer;
  fileName: string;
}

export interface Incoming {
  trackId: string;
  bytes: ArrayBuffer;
  fileName: string;
}

/** `trackId` is known on the receiving side only once the header has landed. */
type Progress = (fraction: number, trackId: string) => void;

/**
 * Send the file down one channel. Resolves when the last chunk is handed to
 * the channel, rejects if the peer stalls or the channel closes.
 *
 * One call per peer: on a LAN N sends is cheaper than the coordination a
 * relay tree would need, and the mesh is already N connections wide.
 */
export async function send(
  channel: RTCDataChannel,
  file: Outgoing,
  onProgress?: Progress,
): Promise<void> {
  const header: Header = {
    type: 'file-header',
    trackId: file.trackId,
    fileName: file.fileName,
    byteLength: file.bytes.byteLength,
  };
  channel.send(JSON.stringify(header));

  for (let offset = 0; offset < file.bytes.byteLength; offset += CHUNK_BYTES) {
    await drain(channel);
    channel.send(file.bytes.slice(offset, offset + CHUNK_BYTES));
    onProgress?.(Math.min(1, (offset + CHUNK_BYTES) / file.bytes.byteLength), file.trackId);
  }

  // A zero-byte file would otherwise never report anything, and the barrier
  // would wait on a transfer that already finished.
  if (file.bytes.byteLength === 0) onProgress?.(1, file.trackId);
}

/**
 * Wait until the channel has room, or decide it never will.
 *
 * bufferedamountlow is the only signal a DataChannel gives that it drained;
 * a channel that has wedged fires nothing at all, which is exactly why the
 * timer is here and not left to the caller.
 */
function drain(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState !== 'open') {
    return Promise.reject(new Error(CLOSED_ERROR));
  }
  if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      fn();
    };
    const onLow = () => done(resolve);
    const onClose = () =>
      done(() => reject(new Error(CLOSED_ERROR)));
    const timer = setTimeout(
      () => done(() => reject(new Error('That peer stalled — no progress for 15 seconds.'))),
      STALL_MS,
    );

    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
  });
}

/**
 * Listen for every file on this channel, one after another, until it fails.
 *
 * One listener for the channel's whole life rather than one per file: the
 * next header can be right behind the last chunk, and a listener that had
 * to be put back between them is a listener that can miss it.
 *
 * Non-transfer traffic is ignored rather than rejected: clock probes and
 * cues share this channel, and a receiver that threw on the first one would
 * take the transfer down with it.
 *
 * `onError` is the end: the channel closed, or a sender overran its own
 * header. Returns a detach.
 */
export function listen(
  channel: RTCDataChannel,
  handlers: { onFile: (file: Incoming) => void; onProgress?: Progress; onError: (err: Error) => void },
): () => void {
  let header: Header | undefined;
  let buffer: Uint8Array<ArrayBuffer> | undefined;
  let filled = 0;

  const detach = () => {
    channel.removeEventListener('message', onMessage);
    channel.removeEventListener('close', onClose);
  };
  const fail = (err: Error) => {
    detach();
    handlers.onError(err);
  };
  /** Hand the finished file on, and be ready for the next header. */
  const deliver = (bytes: ArrayBuffer) => {
    const { trackId, fileName } = header!;
    header = undefined;
    buffer = undefined;
    handlers.onFile({ trackId, bytes, fileName });
  };

  const onClose = () => fail(new Error(CLOSED_ERROR));

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      const parsed = parseHeader(event.data);
      if (!parsed) return; // Someone else's message on a shared channel.
      header = parsed;
      buffer = new Uint8Array(parsed.byteLength);
      filled = 0;
      if (parsed.byteLength === 0) {
        handlers.onProgress?.(1, parsed.trackId);
        deliver(new ArrayBuffer(0));
      }
      return;
    }

    // Bytes before a header are bytes we cannot place. Drop them rather
    // than guessing at an offset.
    if (!header || !buffer) return;

    const chunk = new Uint8Array(event.data as ArrayBuffer);
    // A sender that overruns its own header is a bug, not something to
    // write past the end of the buffer for.
    if (filled + chunk.byteLength > buffer.byteLength) {
      return fail(new Error('The file arrived larger than it said it would be.'));
    }
    buffer.set(chunk, filled);
    filled += chunk.byteLength;
    handlers.onProgress?.(filled / buffer.byteLength, header.trackId);

    if (filled === buffer.byteLength) deliver(buffer.buffer);
  };

  channel.addEventListener('message', onMessage);
  channel.addEventListener('close', onClose);
  return detach;
}

/** Listen for one file on this channel, and then stop. */
export function receive(channel: RTCDataChannel, onProgress?: Progress): Promise<Incoming> {
  return new Promise((resolve, reject) => {
    const detach = listen(channel, {
      onProgress,
      onError: reject,
      onFile: (file) => {
        detach();
        resolve(file);
      },
    });
  });
}

function parseHeader(raw: string): Header | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as Header).type === 'file-header' &&
      typeof (value as Header).trackId === 'string' &&
      typeof (value as Header).fileName === 'string' &&
      Number.isSafeInteger((value as Header).byteLength) &&
      (value as Header).byteLength >= 0
    ) {
      return value as Header;
    }
  } catch {
    // Not JSON at all. Not ours either.
  }
  return undefined;
}
