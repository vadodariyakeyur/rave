import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from '@rave/protocol';
import { RoomRegistry } from './rooms.ts';
import { iceServers } from './ice.ts';

/**
 * The whole protocol, as a function of one socket.
 *
 * Split from the listener so tests can drive it with a fake socket: the
 * relay's same-room guard is a security boundary, and a boundary with no
 * test is a boundary that quietly stops holding.
 */

export const rooms = new RoomRegistry();

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
        log('peer joined', { code: result.room.code, peers: result.room.peers.length });
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
      log('peer left', { code: result.room.code, rooms: rooms.size });
      return;
    }
    if (result.kind === 'unknown') return;

    // The room is gone. A frozen roster would look like a slow network; this
    // says it is over, and which of the two ways it ended.
    broadcast(others, { type: 'room-closed', code: result.code, reason: result.reason });
    for (const id of others) socketByPeer.delete(id);
    log('room closed', { code: result.code, reason: result.reason, rooms: rooms.size });
  });
}
