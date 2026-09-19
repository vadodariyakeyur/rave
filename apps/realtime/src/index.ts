import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { handleConnection, metrics } from './server.ts';

const PORT = Number(process.env['PORT'] ?? 8080);

const server = createServer((req, res) => {
  if (req.url === '/metrics') {
    // Async because the gauges collect off the registry on the way out.
    // Failing the scrape with a 500 is right: an empty 200 reads as a live
    // service reporting zero rooms, which is the wrong alarm.
    metrics
      .render()
      .then(({ body, contentType }) => {
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      })
      .catch((err: unknown) => {
        console.error(
          JSON.stringify({ msg: 'metrics failed', error: String(err), at: new Date().toISOString() }),
        );
        res.writeHead(500).end();
      });
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', handleConnection);

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
