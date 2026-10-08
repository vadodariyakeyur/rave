import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@rave/protocol';
import type { Outcome, RoomHub } from './hub.ts';
import { iceServers } from './ice.ts';

/**
 * The transport: sockets in, sockets out, and nothing about rooms.
 *
 * What a message means is the hub's business. This maps a socket to the peer
 * it became and delivers what the hub says to whoever it names — split from
 * the listener so tests can drive it with a fake socket: the relay's
 * same-room guard is a security boundary, and a boundary with no test is a
 * boundary that quietly stops holding.
 */

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields, at: new Date().toISOString() }));
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** A connection handler over one hub, with its own socket table. */
export function connectionHandler(hub: RoomHub): (socket: WebSocket) => void {
  /**
   * Sockets by peer, so a roster change can reach everyone else in the room.
   * The hub deliberately knows nothing about transports, so the mapping
   * lives here rather than on Room.
   */
  const socketByPeer = new Map<string, WebSocket>();

  function deliver(socket: WebSocket, outcome: Outcome): void {
    for (const msg of outcome.reply) send(socket, msg);
    for (const { to, msg } of outcome.deliveries) {
      const target = socketByPeer.get(to);
      if (target) send(target, msg);
    }
    for (const peerId of outcome.dropped) {
      const target = socketByPeer.get(peerId);
      socketByPeer.delete(peerId);
      // Leaving it open holds a socket per dropped peer until they happen to
      // close the tab.
      target?.close();
    }
  }

  return (socket) => {
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

      const outcome = hub.handle(peerId, msg);
      if (outcome.identity !== undefined) {
        peerId = outcome.identity;
        // Before delivering: the first roster is addressed to this peer.
        socketByPeer.set(peerId, socket);
      }
      deliver(socket, outcome);
    });

    socket.on('close', () => {
      if (peerId === undefined) return;
      socketByPeer.delete(peerId);
      deliver(socket, hub.leave(peerId));
    });
  };
}
