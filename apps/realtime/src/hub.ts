import type { ClientMessage, RoomList, ServerMessage } from '@rave/protocol';
import type { Room, RoomRegistry } from './rooms.ts';

/**
 * The whole protocol, as a function of one message.
 *
 * Every path that changes a roster ends the same way — tell the room, and
 * tell the homepage its list is stale. Here that goes through
 * {@link RoomHub.#announce} and nowhere else, so a new path cannot skip a
 * step it never had to remember.
 *
 * Nothing in here knows what a socket is. A message goes in with the sender's
 * peer id, and what comes out is who must hear what. The transport delivers
 * it, which is also what makes this testable without one.
 */

/** One message for one peer in a room. */
export interface Delivery {
  to: string;
  msg: ServerMessage;
}

export interface Outcome {
  /** Set when this message gave the sender a peer id. The transport maps it. */
  identity?: string;
  /** For the sender itself, who may not be anyone yet. Sent first. */
  reply: ServerMessage[];
  /** For peers by id, in order. Sent after the reply. */
  deliveries: Delivery[];
  /** Peers this left with no room. Their connection is finished. */
  dropped: string[];
  /** The sender wants the room list from now on. */
  watch?: true;
  /** What the room list shows has changed. Everyone watching gets a new one. */
  listChanged?: true;
}

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

const ALREADY_IN_ROOM = 'This connection already belongs to a room.';

const JOIN_REFUSAL = {
  'room-not-found': 'No room with that code. Check it and try again.',
  'passcode-required': 'This room needs a passcode.',
  'passcode-wrong': 'That passcode is not right.',
} as const;

const MODE_REFUSAL = 'Only the creator can change what the room is doing.';

const KICK_REFUSAL = {
  'not-creator': 'Only the creator can remove someone.',
  'peer-not-found': 'That peer is not in this room.',
} as const;

export class RoomHub {
  readonly #rooms: RoomRegistry;
  readonly #log: Log;

  constructor(input: { rooms: RoomRegistry; log?: Log }) {
    this.#rooms = input.rooms;
    this.#log = input.log ?? (() => {});
  }

  /** Every live room, for whoever is watching the homepage. */
  list(): RoomList {
    return { type: 'room-list', rooms: this.#rooms.list() };
  }

  /** Act on one message from the peer this connection is, if it is one yet. */
  handle(peerId: string | undefined, msg: ClientMessage): Outcome {
    switch (msg.type) {
      case 'ping':
        return reply({ type: 'pong', nonce: msg.nonce });

      case 'watch-rooms':
        return { ...reply(this.list()), watch: true };

      case 'create-room': {
        // One room per connection: a second create would orphan the first.
        if (peerId !== undefined) return refuse('invalid-request', ALREADY_IN_ROOM);

        const room = this.#rooms.create(msg);
        const creator = room.peers[0]!;
        this.#log('room created', { code: room.code, peers: room.peers.length });
        return {
          ...this.#announce(room),
          identity: creator.peerId,
          reply: [
            {
              type: 'room-created',
              code: room.code,
              peerId: creator.peerId,
              createdAt: room.createdAt,
            },
          ],
        };
      }

      case 'join-room': {
        if (peerId !== undefined) return refuse('invalid-request', ALREADY_IN_ROOM);

        const result = this.#rooms.join(msg.code, msg.displayName, msg.passcode);
        if (!result.ok) return refuse(result.reason, JOIN_REFUSAL[result.reason]);

        this.#log('peer joined', { code: result.room.code, peers: result.room.peers.length });
        return {
          // Everyone gets the same roster, the joiner included: one message
          // shape means no separate "you" and "them" views to keep in step.
          ...this.#announce(result.room),
          identity: result.peerId,
          reply: [{ type: 'room-joined', code: result.room.code, peerId: result.peerId }],
        };
      }

      case 'kick': {
        const result =
          peerId === undefined
            ? ({ ok: false, reason: 'not-creator' } as const)
            : this.#rooms.kick(peerId, msg.peerId);
        if (!result.ok) return refuse(result.reason, KICK_REFUSAL[result.reason]);

        this.#log('peer kicked', { code: result.room.code, peers: result.room.peers.length });
        const announced = this.#announce(result.room);
        return {
          ...announced,
          deliveries: [
            // The kicked first. They are out of the roster already, so the
            // announcement that follows cannot reach them.
            { to: msg.peerId, msg: { type: 'room-closed', code: result.room.code, reason: 'kicked' } },
            ...announced.deliveries,
          ],
          // Nothing more will be said to them on this connection. Coming
          // back is a fresh join.
          dropped: [msg.peerId],
        };
      }

      case 'now-playing': {
        // Not from a creator: nothing to show, and nobody to tell.
        const room = peerId === undefined ? undefined : this.#rooms.setNowPlaying(peerId, msg.title);
        return room ? { ...NOTHING, listChanged: true } : NOTHING;
      }

      case 'set-mode': {
        const room = peerId === undefined ? undefined : this.#rooms.setMode(peerId, msg.mode);
        if (!room) return refuse('not-creator', MODE_REFUSAL);
        this.#log('mode set', { code: room.code, mode: room.mode });
        // The roster carries the mode, so this is how everyone, and anyone
        // arriving later, learns it.
        return this.#announce(room);
      }

      case 'react': {
        const room = peerId === undefined ? undefined : this.#rooms.roomForPeer(peerId);
        if (peerId === undefined || !room) return NOTHING;
        // Everyone but the sender, who draws their own at once rather than
        // waiting for a round trip, and `from` stamped here, never taken.
        return {
          reply: [],
          deliveries: room.peers
            .filter((p) => p.peerId !== peerId)
            .map((p) => ({ to: p.peerId, msg: { type: 'reaction', from: peerId, reaction: msg.reaction } as const })),
          dropped: [],
        };
      }

      case 'signal': {
        // Same-room check, not just same-server: without it any connection
        // could address any peer id and push SDP at a stranger's browser.
        const room = peerId === undefined ? undefined : this.#rooms.roomForPeer(peerId);
        if (peerId === undefined || !room || !room.peers.some((p) => p.peerId === msg.to)) {
          return refuse('peer-not-found', 'That peer is not in this room.');
        }
        return {
          reply: [],
          // `from` is stamped here, never taken from the sender: a peer must
          // not be able to pose as another.
          deliveries: [{ to: msg.to, msg: { type: 'signal', from: peerId, data: msg.data } }],
          dropped: [],
        };
      }
    }
  }

  /** The peer's connection is gone. What the room it was in must hear. */
  leave(peerId: string): Outcome {
    const room = this.#rooms.roomForPeer(peerId);
    if (!room) return NOTHING;
    // Captured before removal: if this was the creator the room is deleted,
    // and the survivors still have to be told why their roster stopped.
    const others = room.peers.filter((p) => p.peerId !== peerId).map((p) => p.peerId);

    const result = this.#rooms.removePeer(peerId);
    if (result.kind === 'unknown') return NOTHING;
    if (result.kind === 'open') {
      this.#log('peer left', { code: result.room.code, rooms: this.#rooms.size });
      return this.#announce(result.room);
    }

    // The room is gone. A frozen roster would look like a slow network; this
    // says it is over, and which of the two ways it ended.
    this.#log('room closed', { code: result.code, reason: result.reason, rooms: this.#rooms.size });
    return {
      reply: [],
      deliveries: others.map((to) => ({
        to,
        msg: { type: 'room-closed', code: result.code, reason: result.reason } as const,
      })),
      // Told, not hung up on: the survivors' sockets close when they leave
      // the page, and each one's own close then finds no room to leave.
      dropped: [],
      listChanged: true,
    };
  }

  /**
   * A roster changed: the whole room hears the new one, and the room list
   * — which shows how many are in each — is stale. The one place either
   * happens.
   */
  #announce(room: Room): Outcome {
    const state = this.#rooms.toState(room);
    return {
      reply: [],
      deliveries: room.peers.map((peer) => ({ to: peer.peerId, msg: state })),
      dropped: [],
      listChanged: true,
    };
  }
}

const NOTHING: Outcome = { reply: [], deliveries: [], dropped: [] };

function reply(msg: ServerMessage): Outcome {
  return { reply: [msg], deliveries: [], dropped: [] };
}

function refuse(
  code: Extract<ServerMessage, { type: 'error' }>['code'],
  message: string,
): Outcome {
  return reply({ type: 'error', code, message });
}
