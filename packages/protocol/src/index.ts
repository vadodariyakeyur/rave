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

/** Server -> client. Confirms the socket is live and the protocol matches. */
export const ServerHello = z.object({
  type: z.literal('server-hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverTime: z.iso.datetime(),
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

/** Server -> client. Something the person needs to see, in their words. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum(['room-not-found', 'room-locked', 'invalid-request']),
  message: z.string().min(1).max(200),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const ClientMessage = z.discriminatedUnion('type', [Ping, CreateRoom]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerHello,
  Pong,
  RoomCreated,
  RoomState,
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
