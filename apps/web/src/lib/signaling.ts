'use client';

import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@rave/protocol';

/**
 * Thin WebSocket wrapper over the protocol package. Same-origin: Caddy
 * proxies /ws to `realtime`, so there is no host to configure and no
 * mixed-content hazard on the LAN.
 */
export class Signaling {
  readonly #socket: WebSocket;
  readonly #queue: string[] = [];
  readonly #handlers = new Set<(msg: ServerMessage) => void>();

  constructor() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.#socket = new WebSocket(`${proto}//${window.location.host}/ws`);
    this.#socket.addEventListener('open', () => {
      for (const raw of this.#queue.splice(0)) this.#socket.send(raw);
    });
    this.#socket.addEventListener('message', (event) => {
      const msg = parseServerMessage(String(event.data));
      // Anything that fails the schema is not ours to act on.
      if (!msg) return;
      for (const handler of this.#handlers) handler(msg);
    });
  }

  /**
   * Returns an unsubscribe. A single slot would let the room page silently
   * replace the create page's handler, so listeners are explicit about their
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
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(raw);
    else this.#queue.push(raw);
  }

  close(): void {
    this.#socket.close();
  }
}
