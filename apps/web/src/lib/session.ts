'use client';

import { RoomCode } from '@rave/protocol';
import { armAudio, decodeBytes, type DecodedTrack } from './audio';
import { LiveRoom } from './room';
import { Signaling } from './signaling';

/**
 * The room this tab is in, held outside React.
 *
 * The socket, the armed AudioContext and the decoded buffer cannot be
 * recreated after the create tap — arming needs a user gesture, and the
 * buffer is the only copy that will ever be sent to peers. So the room
 * survives the route change here instead of in component state, which the
 * navigation would drop. A refresh deliberately loses this: that is the
 * reload landing on the pre-join tap again, not a bug.
 */
let current: LiveRoom | undefined;
const listeners = new Set<() => void>();

/** Enter a room, leaving whichever one this tab was in before. */
export function setRoom(room: LiveRoom | undefined): void {
  if (room === current) return;
  // The old room's socket and audio are no longer anybody's: without this
  // the server keeps a peer in a room whose tab has moved on.
  current?.close();
  current = room;
  for (const listener of [...listeners]) listener();
}

export function getRoom(): LiveRoom | undefined {
  return current;
}

/** For useSyncExternalStore. */
export function subscribeRoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Arm audio, decode, then create the room — in that order, and only that
 * order. The AudioContext must be constructed inside the caller's gesture
 * (so this must be called synchronously from the handler), and the room must
 * not exist until playback is known to be possible.
 */
export async function createRoom(input: {
  roomName: string;
  displayName: string;
  file: File;
}): Promise<LiveRoom> {
  const audioContext = new AudioContext();
  try {
    await armAudio(audioContext);
    // Read once: decodeBytes copies for the decoder, so these survive to be
    // sent to every peer.
    const bytes = await input.file.arrayBuffer();
    const decoded: DecodedTrack = await decodeBytes(audioContext, bytes);

    const signaling = new Signaling();
    const entered = await signaling.enter({
      type: 'create-room',
      roomName: input.roomName,
      displayName: input.displayName,
      durationSeconds: decoded.durationSeconds,
    });
    const room = new LiveRoom({
      signaling,
      audioContext,
      entered,
      file: { buffer: decoded.buffer, bytes, fileName: input.file.name },
    });
    setRoom(room);
    return room;
  } catch (err) {
    // No room came of it, so the only thing left open is the context.
    await audioContext.close();
    throw err;
  }
}

/** One wording for a code that leads nowhere, whatever the reason. */
export const UNKNOWN_ROOM = 'No room with that code. Check it and try again.';

/**
 * Arm audio, then join. Same ordering rule as createRoom and the same reason:
 * the AudioContext must be constructed inside the caller's gesture, so this
 * has to be called synchronously from the Join handler. There is no file to
 * decode yet — it arrives from the creator once the room is entered.
 */
export async function joinRoom(input: { code: string; displayName: string }): Promise<LiveRoom> {
  // A malformed code cannot parse server-side, so without this the person
  // gets "message could not be understood" for what is really a bad link.
  const parsed = RoomCode.safeParse(input.code);
  if (!parsed.success) throw new Error(UNKNOWN_ROOM);

  const audioContext = new AudioContext();
  try {
    await armAudio(audioContext);
    const signaling = new Signaling();
    const entered = await signaling.enter({
      type: 'join-room',
      code: parsed.data,
      displayName: input.displayName,
    });
    const room = new LiveRoom({ signaling, audioContext, entered });
    setRoom(room);
    return room;
  } catch (err) {
    await audioContext.close();
    throw err;
  }
}
