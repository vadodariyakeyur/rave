'use client';

import {
  parseServerMessage,
  type ClientMessage,
  type CreateRoom,
  type IceServer,
  type JoinRoom,
  type ErrorMessage,
  type RoomState,
  type RoomSummary,
  type ServerMessage,
} from '@rave/protocol';

/** One wording for a socket that went away before the room was entered. */
export const CONNECTION_LOST = 'Lost the connection to the server. Check the network and try again.';

/**
 * What entering a room settles: who we are, who is here, and how to reach
 * them. Three messages on the wire, one answer here.
 */
export interface Entered {
  peerId: string;
  /**
   * From server-hello, so a STUN change is a restart of `realtime` rather
   * than a rebuild of the web image.
   */
  iceServers: IceServer[];
  state: RoomState;
}

/**
 * The server said no. Carries its code as well as its words, because the
 * join screen does different things for a missing passcode and a wrong one.
 */
export class EnterRefused extends Error {
  constructor(
    message: string,
    readonly code: ErrorMessage['code'],
  ) {
    super(message);
  }
}

/** The slice of WebSocket this needs — which the real one already is. */
export type SignalingSocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>;

/** WebSocket.OPEN, spelled out: the global does not exist where tests run. */
const OPEN = 1;

/**
 * Same-origin: Caddy proxies /ws to `realtime`, so there is no host to
 * configure and no mixed-content hazard on the LAN.
 */
function openSocket(): SignalingSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/ws`);
}

/**
 * The server wire, from this side: the protocol package over one socket,
 * and the handshake that turns a socket into a place in a room.
 */
export class Signaling {
  readonly #socket: SignalingSocket;
  readonly #queue: string[] = [];
  readonly #handlers = new Set<(msg: ServerMessage) => void>();

  /** The socket is taken, not made, so a test can hand in its own. */
  constructor(socket: SignalingSocket = openSocket()) {
    this.#socket = socket;
    this.#socket.addEventListener('open', () => {
      for (const raw of this.#queue.splice(0)) this.#socket.send(raw);
    });
    this.#socket.addEventListener('message', (event) => {
      const msg = parseServerMessage(String((event as MessageEvent).data));
      // Anything that fails the schema is not ours to act on.
      if (!msg) return;
      for (const handler of [...this.#handlers]) handler(msg);
    });
  }

  /**
   * Create or join, and wait until the room is actually entered.
   *
   * The server answers with our own peer id (room-created or room-joined)
   * and then the roster. Neither alone is enough: the roster does not say
   * which peer we are, and the identity does not carry the roster. The ICE
   * list rode in earlier on server-hello.
   *
   * A refusal or a dropped socket rejects and closes the socket — nothing
   * was entered, so there is nothing to keep. On success the handshake's own
   * listeners are gone before this resolves: whoever takes the room next
   * subscribes for themselves.
   */
  enter(request: CreateRoom | JoinRoom): Promise<Entered> {
    return new Promise<Entered>((resolve, reject) => {
      const fail = (err: Error) => {
        unsubscribe();
        this.close();
        reject(err);
      };
      const unsubscribeClose = this.onClose(() => fail(new Error(CONNECTION_LOST)));

      let peerId: string | undefined;
      let iceServers: IceServer[] = [];
      const unsubscribeMessage = this.onMessage((msg) => {
        if (msg.type === 'error') return fail(new EnterRefused(msg.message, msg.code));
        if (msg.type === 'server-hello') {
          iceServers = msg.iceServers;
          return;
        }
        if (msg.type === 'room-created' || msg.type === 'room-joined') {
          peerId = msg.peerId;
          return;
        }
        if (msg.type !== 'room-state' || peerId === undefined) return;
        unsubscribe();
        resolve({ peerId, iceServers, state: msg });
      });

      function unsubscribe(): void {
        unsubscribeClose();
        unsubscribeMessage();
      }

      this.send(request);
    });
  }

  /**
   * The room list, now and every time it changes, for as long as this
   * socket is open. The homepage's whole use of the server.
   */
  watchRooms(onList: (rooms: RoomSummary[]) => void): () => void {
    const unsubscribe = this.onMessage((msg) => {
      if (msg.type === 'room-list') onList(msg.rooms);
    });
    this.send({ type: 'watch-rooms' });
    return unsubscribe;
  }

  /**
   * Returns an unsubscribe. A single slot would let the room silently
   * replace the handshake's handler, so listeners are explicit about their
   * own lifetime instead.
   */
  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.#socket.addEventListener('close', handler);
    this.#socket.addEventListener('error', handler);
    return () => {
      this.#socket.removeEventListener('close', handler);
      this.#socket.removeEventListener('error', handler);
    };
  }

  /** Buffers until the socket opens, so callers never race the handshake. */
  send(msg: ClientMessage): void {
    const raw = JSON.stringify(msg);
    if (this.#socket.readyState === OPEN) this.#socket.send(raw);
    else this.#queue.push(raw);
  }

  close(): void {
    this.#socket.close();
  }
}
