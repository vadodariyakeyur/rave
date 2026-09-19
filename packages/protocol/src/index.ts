import { z } from 'zod';

/**
 * Wire protocol between `web` and `realtime`.
 *
 * Every message crossing the WebSocket is validated against these schemas on
 * both ends — one source of truth rather than two hand-kept copies.
 *
 * Timestamps here are UTC ISO-8601: they are for humans and logs. Scheduling
 * uses a monotonic clock and never appears in this file.
 */

export const PROTOCOL_VERSION = 1;

/**
 * ICE servers, as RTCPeerConnection wants them.
 *
 * Shaped to RTCIceServer rather than a bare url list because phase 2 adds
 * TURN, which needs credentials — a list of strings would have to be
 * replaced, and this only has to be filled in.
 */
export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/**
 * Server -> client. Confirms the socket is live and the protocol matches.
 *
 * Carries the ICE list because the alternative, NEXT_PUBLIC_*, is baked into
 * the bundle at build time: changing a STUN server would mean rebuilding the
 * web image. Here it is a restart of `realtime`, and it rides a message every
 * socket already receives first.
 */
export const ServerHello = z.object({
  type: z.literal('server-hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverTime: z.iso.datetime(),
  iceServers: z.array(IceServer),
});
export type ServerHello = z.infer<typeof ServerHello>;

/** Client -> server. Liveness probe. */
export const Ping = z.object({
  type: z.literal('ping'),
  nonce: z.string().min(1).max(64),
});
export type Ping = z.infer<typeof Ping>;

/** Server -> client. Echoes the nonce from a {@link Ping}. */
export const Pong = z.object({
  type: z.literal('pong'),
  nonce: z.string().min(1).max(64),
});
export type Pong = z.infer<typeof Pong>;

/**
 * Room codes are the thing a person reads aloud across a room, so the
 * alphabet excludes characters that get misheard or mistyped: no 0/O, no
 * 1/I/L. Uppercase only, so input can be normalised without ambiguity.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export const RoomCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'invalid room code');
export type RoomCode = z.infer<typeof RoomCode>;

/** A display name is shown to other people, so it is bounded and non-blank. */
export const DisplayName = z.string().trim().min(1).max(32);
export type DisplayName = z.infer<typeof DisplayName>;

export const RoomName = z.string().trim().min(1).max(64);
export type RoomName = z.infer<typeof RoomName>;

/** A peer as everyone in the room sees them. */
export const Peer = z.object({
  peerId: z.uuid(),
  displayName: DisplayName,
  isCreator: z.boolean(),
  /** True once this peer holds the fully decoded file. The creator starts true. */
  ready: z.boolean(),
});
export type Peer = z.infer<typeof Peer>;

/**
 * Client -> server. Sent only after the creator's browser has decoded the
 * file: the room must not exist until playback is known to be possible.
 */
export const CreateRoom = z.object({
  type: z.literal('create-room'),
  roomName: RoomName,
  displayName: DisplayName,
  /** Track duration in seconds, from the decoded buffer. Display only. */
  durationSeconds: z.number().positive().finite(),
});
export type CreateRoom = z.infer<typeof CreateRoom>;

/**
 * Client -> server. Sent from the pre-join tap, which is also what arms the
 * joiner's audio. The code is whatever the person typed or the link carried.
 */
export const JoinRoom = z.object({
  type: z.literal('join-room'),
  code: RoomCode,
  displayName: DisplayName,
});
export type JoinRoom = z.infer<typeof JoinRoom>;

/**
 * Client -> server. "I hold the whole file and it decoded."
 *
 * No payload: readiness is a fact about the sender's own device, and the
 * server already knows which socket sent this. A peerId field would be a
 * claim someone could make about somebody else.
 */
export const Ready = z
  .object({
    type: z.literal('ready'),
  })
  // Strict, unlike the rest: zod would otherwise strip an extra peerId and
  // parse this happily, which reads as accepting a claim we then ignore.
  .strict();
export type Ready = z.infer<typeof Ready>;

/**
 * Client -> server, then server -> client, relayed to one named peer.
 *
 * The payload is opaque on purpose: it carries SDP and ICE candidates whose
 * shape belongs to the browser, and mirroring RTCSessionDescriptionInit in
 * zod would be a second definition to keep in step for no safety gained —
 * the server never reads it, it only forwards it.
 *
 * `to` on the way in, `from` on the way out, and the server stamps `from`
 * itself so a peer cannot claim to be someone else.
 */
export const Signal = z.object({
  type: z.literal('signal'),
  to: z.uuid(),
  data: z.unknown(),
});
export type Signal = z.infer<typeof Signal>;

export const SignalFrom = z.object({
  type: z.literal('signal'),
  from: z.uuid(),
  data: z.unknown(),
});
export type SignalFrom = z.infer<typeof SignalFrom>;

/** Server -> client. The room exists; this is its code. */
export const RoomCreated = z.object({
  type: z.literal('room-created'),
  code: RoomCode,
  peerId: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type RoomCreated = z.infer<typeof RoomCreated>;

/** Server -> client. The full roster, resent whenever it changes. */
export const RoomState = z.object({
  type: z.literal('room-state'),
  code: RoomCode,
  roomName: RoomName,
  peers: z.array(Peer),
  locked: z.boolean(),
});
export type RoomState = z.infer<typeof RoomState>;

/**
 * Server -> client. The joiner's own peerId, which the roster alone cannot
 * give them — it lists everyone without saying which one they are. Mirrors
 * room-created, and is followed by a room-state broadcast.
 */
export const RoomJoined = z.object({
  type: z.literal('room-joined'),
  code: RoomCode,
  peerId: z.uuid(),
});
export type RoomJoined = z.infer<typeof RoomJoined>;

/**
 * Server -> client. The room is gone and will not come back. Distinct from a
 * dropped socket, which might reconnect: this one is final, so the UI can say
 * what happened instead of leaving a roster frozen on screen.
 */
export const RoomClosed = z.object({
  type: z.literal('room-closed'),
  code: RoomCode,
  reason: z.enum(['creator-left', 'room-empty']),
});
export type RoomClosed = z.infer<typeof RoomClosed>;

/** Server -> client. Something the person needs to see, in their words. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum(['room-not-found', 'room-locked', 'invalid-request', 'peer-not-found']),
  message: z.string().min(1).max(200),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const ClientMessage = z.discriminatedUnion('type', [Ping, CreateRoom, JoinRoom, Signal, Ready]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerHello,
  Pong,
  RoomCreated,
  RoomJoined,
  RoomState,
  RoomClosed,
  SignalFrom,
  ErrorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Parse untrusted wire bytes into a {@link ClientMessage}. Never throws. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return ClientMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Parse untrusted wire bytes into a {@link ServerMessage}. Never throws. */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return ServerMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
