import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from '@rave/protocol';
import { RoomRegistry } from './rooms.ts';

const PORT = Number(process.env['PORT'] ?? 8080);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new RoomRegistry();

function log(msg: string, fields: Record<string, unknown> = {}): void {
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

wss.on('connection', (socket) => {
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
    const code = room.code;

    const survivor = rooms.removePeer(peerId);
    if (survivor) {
      broadcast(others, rooms.toState(survivor));
      log('peer left', { code, rooms: rooms.size });
      return;
    }

    // No survivor means the room is gone. A frozen roster would look like a
    // slow network; this says it is over.
    broadcast(others, { type: 'room-closed', code, reason: 'creator-left' });
    for (const id of others) socketByPeer.delete(id);
    log('room closed', { code, rooms: rooms.size });
  });
});

wss.on('error', (err) => {
  console.error(
    JSON.stringify({ msg: 'wss error', error: String(err), at: new Date().toISOString() }),
  );
});

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      msg: 'realtime listening',
      port: PORT,
      at: new Date().toISOString(),
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    wss.close();
    server.close(() => process.exit(0));
  });
}
