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

/** What the room is for, as the room list shows it. Optional, so it may be empty. */
export const Description = z.string().trim().max(200);
export type Description = z.infer<typeof Description>;

/**
 * The creator's gate on a room. Bounded below so it is not a single key
 * press, and above because it is compared byte for byte on every join.
 */
export const Passcode = z.string().min(4).max(32);
export type Passcode = z.infer<typeof Passcode>;

/**
 * What a room is doing: playing the creator's tracks in sync, or letting
 * everyone talk to everyone. The creator switches it, at any time.
 */
export const Mode = z.enum(['music', 'talk']);
export type Mode = z.infer<typeof Mode>;

/** A peer as everyone in the room sees them. */
export const Peer = z.object({
  peerId: z.uuid(),
  displayName: DisplayName,
  isCreator: z.boolean(),
});
export type Peer = z.infer<typeof Peer>;

/**
 * Client -> server. A room starts empty: the creator adds tracks once they
 * are inside it, so there is nothing about audio here.
 */
export const CreateRoom = z.object({
  type: z.literal('create-room'),
  roomName: RoomName,
  description: Description.optional(),
  displayName: DisplayName,
  /** Absent means anyone who can see the room can join it. */
  passcode: Passcode.optional(),
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
  /**
   * Looser than {@link Passcode} on purpose: a guess that is too short is a
   * wrong passcode, and should be told so rather than fail to parse.
   */
  passcode: z.string().max(32).optional(),
});
export type JoinRoom = z.infer<typeof JoinRoom>;

/** Client -> server. From the homepage: send me the room list, and keep it current. */
export const WatchRooms = z.object({ type: z.literal('watch-rooms') });
export type WatchRooms = z.infer<typeof WatchRooms>;

/** Client -> server. The creator removes a member. They may join again. */
export const Kick = z.object({
  type: z.literal('kick'),
  peerId: z.uuid(),
});
export type Kick = z.infer<typeof Kick>;

/**
 * Client -> server. The creator says what the room list should show.
 *
 * The server sees no playback at all — cues travel peer to peer — so this is
 * the only way it can know. Display only; null when nothing is playing.
 */
export const NowPlaying = z.object({
  type: z.literal('now-playing'),
  title: z.string().trim().max(200).nullable(),
});
export type NowPlaying = z.infer<typeof NowPlaying>;

/**
 * A reaction is one of a fixed few, never free text: it is relayed to a whole
 * room, and a fixed set is something the server can relay without reading.
 */
export const Reaction = z.enum(['heart', 'fire', 'thumbs-up', 'party', 'laugh']);
export type Reaction = z.infer<typeof Reaction>;

/** Client -> server. Show everyone else in the room this reaction, from me. */
export const React = z.object({
  type: z.literal('react'),
  reaction: Reaction,
});
export type React = z.infer<typeof React>;

/** Server -> client. Someone in the room reacted. The server stamps `from`. */
export const ReactionFrom = z.object({
  type: z.literal('reaction'),
  from: z.uuid(),
  reaction: Reaction,
});
export type ReactionFrom = z.infer<typeof ReactionFrom>;

/** Client -> server. The creator switches the room between music and talk. */
export const SetMode = z.object({
  type: z.literal('set-mode'),
  mode: Mode,
});
export type SetMode = z.infer<typeof SetMode>;

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
  description: Description,
  mode: Mode,
  peers: z.array(Peer),
});
export type RoomState = z.infer<typeof RoomState>;

/** A room as the homepage lists it. Never carries the passcode, only that there is one. */
export const RoomSummary = z.object({
  code: RoomCode,
  roomName: RoomName,
  description: Description,
  memberCount: z.number().int().nonnegative(),
  hasPasscode: z.boolean(),
  mode: Mode,
  nowPlaying: z.string().nullable(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** Server -> client. Every live room, resent to watchers whenever it changes. */
export const RoomList = z.object({
  type: z.literal('room-list'),
  rooms: z.array(RoomSummary),
});
export type RoomList = z.infer<typeof RoomList>;

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
 * Server -> client. This room is over for the recipient and will not come
 * back. Distinct from a dropped socket, which might reconnect: this one is
 * final, so the UI can say what happened instead of leaving a roster frozen
 * on screen.
 *
 * 'kicked' is the odd one out: the room carries on, just not for them. Same
 * message because the consequence is identical — there is nothing left on
 * screen worth keeping live.
 */
export const RoomClosed = z.object({
  type: z.literal('room-closed'),
  code: RoomCode,
  reason: z.enum(['creator-left', 'room-empty', 'kicked']),
});
export type RoomClosed = z.infer<typeof RoomClosed>;

/** Server -> client. Something the person needs to see, in their words. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum([
    'room-not-found',
    'invalid-request',
    'peer-not-found',
    'not-creator',
    'passcode-required',
    'passcode-wrong',
  ]),
  message: z.string().min(1).max(200),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const ClientMessage = z.discriminatedUnion('type', [
  Ping,
  CreateRoom,
  JoinRoom,
  Signal,
  WatchRooms,
  Kick,
  NowPlaying,
  SetMode,
  React,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerHello,
  Pong,
  RoomCreated,
  RoomJoined,
  RoomState,
  RoomList,
  RoomClosed,
  SignalFrom,
  ReactionFrom,
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
