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

export const ClientMessage = z.discriminatedUnion('type', [Ping]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [ServerHello, Pong]);
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
