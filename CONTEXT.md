# rave

Synchronized peer-to-peer audio rooms: one person opens a room and adds tracks to its
playlist, others join from the room list or with a room code, and every device plays the
same track at the same instant.

This file says what the system is and how it fits together. The words it uses are defined in
[GLOSSARY.md](GLOSSARY.md). The decisions behind the shape are in [docs/adr/](docs/adr/).
Together they are the source of truth for the project; when code and these disagree, find out
which is wrong and fix it.

## How it is built

A pnpm workspace of three packages (`pnpm-workspace.yaml`):

| Package | Path | What it is |
|---|---|---|
| `@rave/protocol` | [packages/protocol](packages/protocol/src/index.ts) | The wire between browser and server: zod schemas, the room code alphabet, and `parseClientMessage` / `parseServerMessage`. Both ends validate against it. |
| `@rave/realtime` | [apps/realtime](apps/realtime/src) | The WebSocket server (`ws`) at `/ws`, plus `/healthz` and `/metrics`. In-memory rooms. |
| `@rave/web` | [apps/web](apps/web/src) | The Next.js 16 app (React 19, React Compiler, Tailwind 4), served standalone. |

Everything that plays audio runs in the browser. The server never sees audio, cues or clock
readings.

### The server

- [rooms.ts](apps/realtime/src/rooms.ts) holds the rooms in memory: create, join (with the
  passcode check, constant-time), kick, remove a peer, list. A room is deleted when its
  creator leaves or when it empties.
- [hub.ts](apps/realtime/src/hub.ts) is the whole protocol as a function of one message. It
  knows nothing about sockets: a message goes in with the sender's peer id, and what comes out
  is who must hear what. Every roster change goes through one method, so the room is told its
  roster and watchers are told the room list is stale.
- [server.ts](apps/realtime/src/server.ts) is the transport: it maps sockets to peers and
  delivers. Five wrong passcodes on one socket close it.
- It relays `signal` messages (SDP and ICE) between peers of the same room and stamps the
  sender itself. It does not read them.
- [metrics.ts](apps/realtime/src/metrics.ts) exposes two gauges, `rave_rooms_live` and
  `rave_peers_live`, read from the registry at scrape time.
- `server-hello` is the first message on every socket and carries the ICE servers, from the
  `ICE_SERVERS` environment variable (default: Google's public STUN; empty means host
  candidates only), so changing them is a restart of `realtime` and not a rebuild of `web`.

### The browser

- [session.ts](apps/web/src/lib/session.ts) holds the one room a tab is in outside React, and
  is where a room is created or joined. Both must run synchronously inside the tap, because
  the `AudioContext` has to be created and armed inside a user gesture
  ([audio.ts](apps/web/src/lib/audio.ts)).
- [room.ts](apps/web/src/lib/room.ts) (`LiveRoom`) owns everything that has to happen in order
  and exposes a snapshot to the screen. The screen decides none of the ordering.
- [mesh.ts](apps/web/src/lib/mesh.ts) opens one WebRTC data channel per connected peer, with
  signaling relayed by the server. The creator connects to every member; a member connects
  only to the creator ([ADR 0002](docs/adr/0002-members-connect-only-to-the-creator.md)).
- Over those channels go: the playlist and cues ([wire.ts](apps/web/src/lib/wire.ts)), clock
  probes ([clock.ts](apps/web/src/lib/clock.ts)) and the files
  ([transfer.ts](apps/web/src/lib/transfer.ts), [distribute.ts](apps/web/src/lib/distribute.ts)).
- [player.ts](apps/web/src/lib/player.ts) schedules playback against the audio clock, never a
  timer.

Pages (`apps/web/src/app`): `/` the room list, `/create`, and `/room/[code]`, which shows
[PreJoin](apps/web/src/app/room/[code]/PreJoin.tsx) until this tab has entered the room. A
refresh loses the room on purpose and lands on pre-join again. `?debug=1` on a room shows the
debug overlay; `?locked=1` on a room link, which the room list adds for a room with a passcode,
makes pre-join ask for the passcode up front.

## How it behaves

- **Opening a room.** The creator enters a room name (up to 64 characters), an optional
  description (up to 200), a display name (up to 32) and an optional passcode. The room starts
  with no tracks.
- **Joining.** From the room list, or by code or link. A room with a passcode asks for it
  unless the link carries it. Anyone may join at any point in a room's life; there is no
  lock, no size cap and no ready barrier ([ADR 0001](docs/adr/0001-late-join-replaces-the-ready-barrier.md)).
- **Tracks.** Only the creator adds, removes, reorders, plays, pauses, resumes, restarts and
  stops. A file is test-decoded when added, so one that cannot be decoded never reaches a
  member. The creator sends every track to every member, one file at a time per member, in
  playlist order. Each device holds tracks encoded and decodes only the current one
  ([ADR 0003](docs/adr/0003-tracks-held-encoded-decoded-on-play.md)).
- **Starting.** The creator selects the track, so every device decodes it at once, then cues
  play at its own clock plus 500 ms. Each member converts the instant with its measured clock
  offset and its user offset, and schedules the start on the audio clock.
- **Staying in sync.** The clock offset is re-measured every five seconds (20 probes, the
  fastest quarter kept, median taken). Every ten seconds a playing device compares itself with
  where the shared clock says it should be: within 5 ms it is left alone, up to 100 ms it is
  nudged by 0.2% playback rate, beyond that it reseeks.
- **Ending.** The creator leaving ends the room for everyone. A member is told why a room
  closed (`creator-left`, `room-empty`, `kicked`); a dropped socket on their own side is shown
  as a lost connection, not as the room closing.
- **Staying awake.** Every device in a room asks for a screen wake lock. The creator also gets
  a warning if their tab is hidden, because their audio clock is the reference.
- **The room list** is pushed to every homepage whenever a roster changes or the creator
  reports a new now-playing title.

## Running it

- `make dev` starts the dev stack (hot reload) behind Caddy over HTTPS on the LAN address;
  `make up` starts the production stack and prints the URL and a QR code; `make ca` exports
  the certificate to trust on phones. `make help` lists the rest.
- Services in [docker-compose.yml](docker-compose.yml): `web` (3000), `realtime` (8080),
  `caddy` (443, the only public entry, proxying `/ws*` and `/healthz` to `realtime` and
  everything else to `web`), `prometheus` (scrapes `realtime:8080`) and `grafana` (3001,
  dashboard uid `rave-sync`). Caddy does not proxy `/metrics`, so only Prometheus reaches it.
- HTTPS is required, not optional: WebRTC and wake locks need a secure context, and Caddy
  issues the certificate from its own internal CA.
- `make test`, `make lint` and `make typecheck` run across every package (`pnpm -r`).
- Node 20.9 or newer, pnpm 10.6.1 (`package.json`).

## Known limits

- Rooms live in one process's memory; a restart ends them all, and there is one `realtime`
  instance.
- The creator's device and uplink carry every transfer, so a large room is limited by that
  one device (ADR 0002).
- A start is not simultaneous by construction: a device that does not yet hold or has not yet
  decoded the track comes in late, in sync (ADR 0001, ADR 0003).
- Only a STUN server is configured; there is no TURN, so peers that cannot reach each other
  directly cannot join the mesh. `ICE_SERVERS` takes URLs only, which cannot carry TURN
  credentials ([ice.ts](apps/realtime/src/ice.ts)).
- Bluetooth output delay cannot be measured by the browser; the user offset slider is the
  only correction.
