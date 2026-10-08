import type { ClientMessage, ServerMessage } from '@rave/protocol';
import { RoomRegistry, type Room, type StartResult } from './rooms.ts';
import { BarrierTimer, type Metrics } from './metrics.ts';

/**
 * The whole protocol, as a function of one message.
 *
 * Every path that changes a roster used to end the same way — tell the room,
 * move the barrier timer, log it — written out by hand each time, and a path
 * that forgot one step looked fine until someone read the dashboard. Here a
 * roster change goes through {@link RoomHub.#announce} and nowhere else, so a
 * new path cannot skip a step it never had to remember.
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
}

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

/** Keyed off the refusal so a new reason cannot ship without its wording. */
const START_REFUSAL: Record<Extract<StartResult, { ok: false }>['reason'], string> = {
  'peers-not-ready': 'Some peers are still downloading. Start anyway to leave them behind.',
  'not-creator': 'Only the creator can start this room.',
  'invalid-request': 'This connection does not belong to a room.',
};

const ALREADY_IN_ROOM = 'This connection already belongs to a room.';

export class RoomHub {
  readonly #rooms: RoomRegistry;
  readonly #metrics: Metrics;
  readonly #barrier: BarrierTimer;
  readonly #log: Log;

  constructor(input: { rooms: RoomRegistry; metrics: Metrics; now?: () => number; log?: Log }) {
    this.#rooms = input.rooms;
    this.#metrics = input.metrics;
    this.#barrier = new BarrierTimer(
      (seconds) => input.metrics.barrierWaitSeconds.observe(seconds),
      input.now,
    );
    this.#log = input.log ?? (() => {});
  }

  /** Act on one message from the peer this connection is, if it is one yet. */
  handle(peerId: string | undefined, msg: ClientMessage): Outcome {
    switch (msg.type) {
      case 'ping':
        return reply({ type: 'pong', nonce: msg.nonce });

      case 'create-room': {
        // One room per connection: a second create would orphan the first.
        if (peerId !== undefined) return refuse('invalid-request', ALREADY_IN_ROOM);

        const room = this.#rooms.create({
          roomName: msg.roomName,
          displayName: msg.displayName,
          durationSeconds: msg.durationSeconds,
        });
        const creator = room.peers[0]!;
        this.#log('room created', { code: room.code, peers: room.peers.length });
        return {
          identity: creator.peerId,
          reply: [
            {
              type: 'room-created',
              code: room.code,
              peerId: creator.peerId,
              createdAt: room.createdAt,
            },
          ],
          deliveries: this.#announce(room, { arrival: true }),
          dropped: [],
        };
      }

      case 'join-room': {
        if (peerId !== undefined) return refuse('invalid-request', ALREADY_IN_ROOM);

        const result = this.#rooms.join(msg.code, msg.displayName);
        if (!result.ok) {
          return refuse(
            result.reason,
            result.reason === 'room-not-found'
              ? 'No room with that code. Check it and try again.'
              : 'That room has already started playing.',
          );
        }

        this.#log('peer joined', { code: result.room.code, peers: result.room.peers.length });
        return {
          identity: result.peerId,
          reply: [{ type: 'room-joined', code: result.room.code, peerId: result.peerId }],
          // Everyone gets the same roster, the joiner included: one message
          // shape means no separate "you" and "them" views to keep in step.
          deliveries: this.#announce(result.room, { arrival: true }),
          dropped: [],
        };
      }

      case 'ready': {
        // No payload to trust: the peer is whoever this connection is. A
        // ready from a connection in no room is a race with a disconnect,
        // not an error anyone needs to see.
        const room = peerId === undefined ? undefined : this.#rooms.setReady(peerId);
        if (!room) return NOTHING;

        this.#log('peer ready', {
          code: room.code,
          ready: room.peers.filter((p) => p.ready).length,
        });
        return { reply: [], deliveries: this.#announce(room), dropped: [] };
      }

      case 'start-playback': {
        const result =
          peerId === undefined
            ? ({ ok: false, reason: 'invalid-request' } as const)
            : this.#rooms.start(peerId, msg.force);
        if (!result.ok) return refuse(result.reason, START_REFUSAL[result.reason]);

        // Forced means peers were left behind, which is the signal — a room
        // that needed force-starting had someone who never made the barrier.
        this.#metrics.startsTotal.inc({ forced: String(result.excluded.length > 0) });
        this.#log('room started', {
          code: result.room.code,
          peers: result.room.peers.length,
          excluded: result.excluded.length,
        });
        return {
          reply: [],
          deliveries: [
            // The excluded first. They are out of the roster already, so the
            // announcement that follows cannot reach them.
            ...result.excluded.map((peer) => ({
              to: peer.peerId,
              msg: { type: 'room-closed', code: result.room.code, reason: 'excluded' } as const,
            })),
            ...this.#announce(result.room),
          ],
          // Nothing will ever be said to them again, and the room is already
          // gone from under them.
          dropped: result.excluded.map((peer) => peer.peerId),
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
      // A leave can complete the barrier too: if the last unready peer is the
      // one who left, the survivors are now all ready and nobody else will
      // send a `ready`. Announcing is what notices.
      return { reply: [], deliveries: this.#announce(result.room), dropped: [] };
    }

    // The room is gone. A frozen roster would look like a slow network; this
    // says it is over, and which of the two ways it ended.
    this.#barrier.close(result.code);
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
    };
  }

  /**
   * A roster changed: the whole room hears the new one, and the barrier
   * timer moves with it. The one place either happens.
   *
   * An arrival reopens the barrier: a joiner arrives unready, so a room that
   * had already settled is waiting again, and that second wait is a real
   * one. Restarting the clock is right even on the first join — the creator
   * was alone until then, and nobody was waiting for them. Any other change
   * can only settle it, and a locked room has no barrier left to time.
   */
  #announce(room: Room, { arrival = false } = {}): Delivery[] {
    if (room.locked) this.#barrier.close(room.code);
    else if (arrival) this.#barrier.open(room.code);
    else this.#barrier.settle(room.code, room.peers);

    const state = this.#rooms.toState(room);
    return room.peers.map((peer) => ({ to: peer.peerId, msg: state }));
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
