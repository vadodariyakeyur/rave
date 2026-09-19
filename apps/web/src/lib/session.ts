'use client';

import { RoomCode, type RoomClosed, type RoomState } from '@rave/protocol';
import { armAudio, decodeFile, type DecodedTrack } from './audio';
import { Signaling } from './signaling';

/**
 * The live room, held outside React.
 *
 * The socket, the armed AudioContext and the decoded buffer cannot be
 * recreated after the create tap — arming needs a user gesture, and the
 * buffer is the only copy that will ever be sent to peers. So they survive
 * the route change here instead of in component state, which the navigation
 * would drop. A refresh deliberately loses this: that is the reload landing
 * on the pre-join tap again (#3), not a bug.
 */
export interface Session {
  signaling: Signaling;
  audioContext: AudioContext;
  /**
   * Absent for a joiner until the transfer lands in #5. The creator has it
   * from the start, which is the whole reason they can issue a code.
   */
  buffer?: AudioBuffer;
  fileName?: string;
  peerId: string;
  code: string;
  state: RoomState;
  /**
   * Why the room ended, if it has. 'lost-connection' is our own socket
   * dropping, which is not the same event as the room closing — telling
   * someone the host left when their wifi died is a lie they will act on.
   */
  ended?: RoomClosed['reason'] | 'lost-connection';
}

let current: Session | undefined;
const listeners = new Set<() => void>();

export function setSession(session: Session | undefined): void {
  current = session;
  for (const listener of listeners) listener();
}

export function getSession(): Session | undefined {
  return current;
}

export function patchSession(patch: Partial<Session>): void {
  if (current) setSession({ ...current, ...patch });
}

/** For useSyncExternalStore. */
export function subscribeSession(listener: () => void): () => void {
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
}): Promise<Session> {
  const audioContext = new AudioContext();
  let decoded: DecodedTrack;
  try {
    await armAudio(audioContext);
    decoded = await decodeFile(audioContext, input.file);
  } catch (err) {
    // Nothing exists yet, so the only cleanup is the context we just opened.
    await audioContext.close();
    throw err;
  }

  const signaling = new Signaling();
  return new Promise<Session>((resolve, reject) => {
    const settle = async (err: Error) => {
      unsubscribe();
      signaling.close();
      await audioContext.close();
      reject(err);
    };
    const unsubscribeClose = signaling.onClose(() => {
      void settle(new Error('Lost the connection to the server. Check the network and try again.'));
    });

    // The server sends room-created (which carries our own peerId) and then
    // room-state. Neither alone is enough: the roster does not say which peer
    // we are, and room-created does not carry the roster.
    let peerId: string | undefined;
    const unsubscribeMessage = signaling.onMessage((msg) => {
      if (msg.type === 'error') return void settle(new Error(msg.message));
      if (msg.type === 'room-created') {
        peerId = msg.peerId;
        return;
      }
      if (msg.type !== 'room-state' || peerId === undefined) return;
      unsubscribe();
      const session: Session = {
        signaling,
        audioContext,
        buffer: decoded.buffer,
        fileName: input.file.name,
        peerId,
        code: msg.code,
        state: msg,
      };
      setSession(session);
      resolve(session);
    });

    // Handing the socket on to the room page means these listeners must go:
    // they belong to the create screen, which is about to unmount.
    function unsubscribe(): void {
      unsubscribeClose();
      unsubscribeMessage();
    }

    signaling.send({
      type: 'create-room',
      roomName: input.roomName,
      displayName: input.displayName,
      durationSeconds: decoded.durationSeconds,
    });
  });
}

/** One wording for a code that leads nowhere, whatever the reason. */
export const UNKNOWN_ROOM = 'No room with that code. Check it and try again.';

/**
 * Arm audio, then join. Same ordering rule as createRoom and the same reason:
 * the AudioContext must be constructed inside the caller's gesture, so this
 * has to be called synchronously from the Join handler. There is no file to
 * decode yet — the transfer arrives in #5.
 */
export async function joinRoom(input: { code: string; displayName: string }): Promise<Session> {
  // A malformed code cannot parse server-side, so without this the person
  // gets "message could not be understood" for what is really a bad link.
  const parsed = RoomCode.safeParse(input.code);
  if (!parsed.success) throw new Error(UNKNOWN_ROOM);

  const audioContext = new AudioContext();
  try {
    await armAudio(audioContext);
  } catch (err) {
    await audioContext.close();
    throw err;
  }

  const signaling = new Signaling();
  return new Promise<Session>((resolve, reject) => {
    const settle = async (err: Error) => {
      unsubscribe();
      signaling.close();
      await audioContext.close();
      reject(err);
    };
    const unsubscribeClose = signaling.onClose(() => {
      void settle(new Error('Lost the connection to the server. Check the network and try again.'));
    });

    // room-joined carries our peerId, room-state the roster. Same two-message
    // handshake as create, for the same reason: neither is enough alone.
    let peerId: string | undefined;
    const unsubscribeMessage = signaling.onMessage((msg) => {
      if (msg.type === 'error') return void settle(new Error(msg.message));
      if (msg.type === 'room-joined') {
        peerId = msg.peerId;
        return;
      }
      if (msg.type !== 'room-state' || peerId === undefined) return;
      unsubscribe();
      const session: Session = {
        signaling,
        audioContext,
        peerId,
        code: msg.code,
        state: msg,
      };
      setSession(session);
      resolve(session);
    });

    function unsubscribe(): void {
      unsubscribeClose();
      unsubscribeMessage();
    }

    signaling.send({ type: 'join-room', code: parsed.data, displayName: input.displayName });
  });
}
