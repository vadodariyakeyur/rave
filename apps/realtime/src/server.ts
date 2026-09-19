import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from '@rave/protocol';
import { RoomRegistry, type StartResult } from './rooms.ts';
import { BarrierTimer, Metrics } from './metrics.ts';
import { iceServers } from './ice.ts';

/**
 * The whole protocol, as a function of one socket.
 *
 * Split from the listener so tests can drive it with a fake socket: the
 * relay's same-room guard is a security boundary, and a boundary with no
 * test is a boundary that quietly stops holding.
 */

export const rooms = new RoomRegistry();

/**
 * The live gauges read off the registry at scrape time rather than being
 * counted at each join and leave. A counter pair would be a second copy of
 * the roster, and the two would drift the first time a code path forgot to
 * decrement.
 */
export const metrics = new Metrics(rooms);

const barrier = new BarrierTimer((seconds) => metrics.barrierWaitSeconds.observe(seconds));

/** Keyed off the refusal so a new reason cannot ship without its wording. */
const START_REFUSAL: Record<Extract<StartResult, { ok: false }>['reason'], string> = {
  'peers-not-ready': 'Some peers are still downloading. Start anyway to leave them behind.',
  'not-creator': 'Only the creator can start this room.',
  'invalid-request': 'This connection does not belong to a room.',
};

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields, at: new Date().toISOString() }));
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * Sockets by peer, so a roster change can reach everyone else in the room.
 * The registry deliberately knows nothing about transports, so the mapping
 * lives here rather than on Room.
 */
const socketByPeer = new Map<string, WebSocket>();

function broadcast(peerIds: readonly string[], msg: ServerMessage): void {
  for (const id of peerIds) {
    const socket = socketByPeer.get(id);
    if (socket) send(socket, msg);
  }
}

export function handleConnection(socket: WebSocket): void {

  // An unhandled 'error' event on a socket takes the whole process down, and
  // peers dropping abruptly is routine. Log and let 'close' do the cleanup.
  socket.on('error', (err) => {
    console.error(
      JSON.stringify({ msg: 'socket error', error: String(err), at: new Date().toISOString() }),
    );
  });

  send(socket, {
    type: 'server-hello',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    iceServers: iceServers(),
  });

  // Which peer this socket belongs to, once it has created or joined a room.
  let peerId: string | undefined;

  socket.on('message', (raw: Buffer) => {
    const msg = parseClientMessage(raw.toString());
    // Unparseable input is dropped, not trusted.
    if (!msg) {
      send(socket, {
        type: 'error',
        code: 'invalid-request',
        message: 'Message could not be understood.',
      });
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(socket, { type: 'pong', nonce: msg.nonce });
        return;

      case 'create-room': {
        // One room per socket: a second create would orphan the first.
        if (peerId !== undefined) {
          send(socket, {
            type: 'error',
            code: 'invalid-request',
            message: 'This connection already belongs to a room.',
          });
          return;
        }

        const room = rooms.create({
          roomName: msg.roomName,
          displayName: msg.displayName,
          durationSeconds: msg.durationSeconds,
        });
        const creator = room.peers[0]!;
        peerId = creator.peerId;

        send(socket, {
          type: 'room-created',
          code: room.code,
          peerId: creator.peerId,
          createdAt: room.createdAt,
        });
        socketByPeer.set(creator.peerId, socket);
        send(socket, rooms.toState(room));
        barrier.open(room.code);
        log('room created', { code: room.code, peers: room.peers.length });
        return;
      }

      case 'join-room': {
        if (peerId !== undefined) {
          send(socket, {
            type: 'error',
            code: 'invalid-request',
            message: 'This connection already belongs to a room.',
          });
          return;
        }

        const result = rooms.join(msg.code, msg.displayName);
        if (!result.ok) {
          send(socket, {
            type: 'error',
            code: result.reason,
            message:
              result.reason === 'room-not-found'
                ? 'No room with that code. Check it and try again.'
                : 'That room has already started playing.',
          });
          return;
        }

        peerId = result.peerId;
        socketByPeer.set(peerId, socket);

        send(socket, { type: 'room-joined', code: result.room.code, peerId });
        // Everyone gets the same roster, the joiner included: one message
        // shape means no separate "you" and "them" views to keep in step.
        broadcast(
          result.room.peers.map((p) => p.peerId),
          rooms.toState(result.room),
        );
        // Reopens the barrier: a joiner arrives unready, so a room that had
        // already settled is waiting again, and that second wait is a real
        // one. Restarting the clock is right even on the first join — the
        // creator was alone until now, and nobody was waiting for them.
        barrier.open(result.room.code);
        log('peer joined', { code: result.room.code, peers: result.room.peers.length });
        return;
      }

      case 'ready': {
        // No payload to trust: the peer is whoever this socket is. A ready
        // from a socket in no room is a race with a disconnect, not an error
        // anyone needs to see.
        const room = peerId === undefined ? undefined : rooms.setReady(peerId);
        if (!room) return;

        broadcast(
          room.peers.map((p) => p.peerId),
          rooms.toState(room),
        );
        barrier.settle(room.code, room.peers);
        log('peer ready', { code: room.code, ready: room.peers.filter((p) => p.ready).length });
        return;
      }

      case 'start-playback': {
        const result = peerId === undefined
          ? ({ ok: false, reason: 'invalid-request' } as const)
          : rooms.start(peerId, msg.force);
        if (!result.ok) {
          send(socket, {
            type: 'error',
            code: result.reason,
            message: START_REFUSAL[result.reason],
          });
          return;
        }

        // The excluded first, while their sockets are still mapped. They are
        // out of the roster already, so the broadcast below cannot reach them.
        for (const peer of result.excluded) {
          const excludedSocket = socketByPeer.get(peer.peerId);
          if (excludedSocket) {
            send(excludedSocket, { type: 'room-closed', code: result.room.code, reason: 'excluded' });
            // Nothing will ever be said down this socket again, and the room
            // is already gone from under them. Leaving it open holds a socket
            // per excluded peer until they happen to close the tab.
            excludedSocket.close();
          }
          socketByPeer.delete(peer.peerId);
        }

        broadcast(
          result.room.peers.map((p) => p.peerId),
          rooms.toState(result.room),
        );
        // Forced means peers were left behind, which is the signal — a room
        // that needed force-starting had someone who never made the barrier.
        metrics.startsTotal.inc({ forced: String(result.excluded.length > 0) });
        barrier.close(result.room.code);
        log('room started', {
          code: result.room.code,
          peers: result.room.peers.length,
          excluded: result.excluded.length,
        });
        return;
      }

      case 'signal': {
        // Same-room check, not just same-server: without it any socket could
        // address any peer id and push SDP at a stranger's browser.
        const room = peerId === undefined ? undefined : rooms.roomForPeer(peerId);
        if (!room || !room.peers.some((p) => p.peerId === msg.to)) {
          send(socket, {
            type: 'error',
            code: 'peer-not-found',
            message: 'That peer is not in this room.',
          });
          return;
        }

        // `from` is stamped here, never taken from the sender: a peer must
        // not be able to pose as another.
        broadcast([msg.to], { type: 'signal', from: peerId!, data: msg.data });
        return;
      }
    }
  });

  socket.on('close', () => {
    if (peerId === undefined) return;
    socketByPeer.delete(peerId);

    const room = rooms.roomForPeer(peerId);
    if (!room) return;
    // Captured before removal: if this was the creator the room is deleted,
    // and the survivors still have to be told why their roster stopped.
    const others = room.peers.filter((p) => p.peerId !== peerId).map((p) => p.peerId);

    const result = rooms.removePeer(peerId);
    if (result.kind === 'open') {
      broadcast(others, rooms.toState(result.room));
      // A leave can complete the barrier too: if the last unready peer is the
      // one who left, the survivors are now all ready and nobody else will
      // send a `ready` to trigger the check.
      barrier.settle(result.room.code, result.room.peers);
      log('peer left', { code: result.room.code, rooms: rooms.size });
      return;
    }
    if (result.kind === 'unknown') return;

    // The room is gone. A frozen roster would look like a slow network; this
    // says it is over, and which of the two ways it ended.
    barrier.close(result.code);
    broadcast(others, { type: 'room-closed', code: result.code, reason: result.reason });
    for (const id of others) socketByPeer.delete(id);
    log('room closed', { code: result.code, reason: result.reason, rooms: rooms.size });
  });
}
