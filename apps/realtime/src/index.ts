import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from '@rave/protocol';

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

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
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

  socket.on('message', (raw: Buffer) => {
    const msg = parseClientMessage(raw.toString());
    // Unparseable input is dropped, not trusted. Rooms and signaling land in #2/#3.
    if (!msg) return;
    if (msg.type === 'ping') send(socket, { type: 'pong', nonce: msg.nonce });
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
