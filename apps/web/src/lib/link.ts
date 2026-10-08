'use client';

import { CLOSED_ERROR, listen, send, type Incoming, type Outgoing } from './transfer';
import { parsePeerMessage, type PeerMessage } from './wire';

type Progress = (fraction: number, trackId: string) => void;

/**
 * One peer, as something you can talk to.
 *
 * A DataChannel does not exist when its peer first appears in the roster,
 * opens some time after that, and carries three kinds of traffic at once.
 * Everything that used the mesh had to know all of that — wait for the
 * channel, notice it open, pick its own messages out of everyone else's —
 * and each did it slightly differently. A link is the same peer with that
 * taken care of: listen whenever, send whenever, and it works once it can.
 */
export interface PeerLink {
  /**
   * Send a message now. False if it could not go — no channel yet, or one
   * that has closed. Best-effort by design: nothing here queues, because
   * every message on this wire is about an instant and is worthless late.
   */
  send(msg: PeerMessage): boolean;

  /** Hear one kind of message, from now until unsubscribed. */
  on<T extends PeerMessage['type']>(
    type: T,
    handler: (msg: Extract<PeerMessage, { type: T }>) => void,
  ): () => void;

  /**
   * Settles when the peer can be reached: resolves once the channel is
   * open, rejects if it closes first or the peer leaves.
   */
  opened(): Promise<void>;

  /** Send the file once the peer can take it. Rejects on a stall or a close. */
  sendFile(file: Outgoing, onProgress?: Progress): Promise<void>;

  /**
   * Receive every file the peer sends, for as long as they can be reached.
   * Never resolves; rejects when the channel closes or the peer leaves.
   */
  receiveFiles(onFile: (file: Incoming) => void, onProgress?: Progress): Promise<never>;
}

type Handler = (msg: never) => void;

/**
 * The link over an RTCDataChannel. The mesh makes these and feeds each one
 * its channel when there is one; nothing else should need the channel.
 */
export class ChannelLink implements PeerLink {
  readonly #handlers = new Map<string, Set<Handler>>();
  readonly #waiting = new Set<{ resolve: (c: RTCDataChannel) => void; reject: (e: Error) => void }>();
  #channel: RTCDataChannel | undefined;
  #detach: (() => void) | undefined;
  #closed = false;

  /** Give the link its channel. A later one replaces an earlier one. */
  attach(channel: RTCDataChannel): void {
    if (this.#closed) return;
    this.#detach?.();
    this.#channel = channel;

    const onMessage = (event: MessageEvent) => this.#dispatch(event.data);
    const onChange = () => this.#settle();
    channel.addEventListener('message', onMessage);
    channel.addEventListener('open', onChange);
    channel.addEventListener('close', onChange);
    this.#detach = () => {
      channel.removeEventListener('message', onMessage);
      channel.removeEventListener('open', onChange);
      channel.removeEventListener('close', onChange);
    };
    // It may already be open, or already dead.
    this.#settle();
  }

  /** The peer is gone. Anything still waiting on them is told so. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach?.();
    this.#detach = undefined;
    this.#channel = undefined;
    this.#handlers.clear();
    for (const waiter of this.#waiting) waiter.reject(new Error(CLOSED_ERROR));
    this.#waiting.clear();
  }

  send(msg: PeerMessage): boolean {
    if (this.#channel?.readyState !== 'open') return false;
    try {
      this.#channel.send(JSON.stringify(msg));
      return true;
    } catch {
      // The channel died between the check and the send. Nothing to do: the
      // mesh will report it, and the room carries on without them.
      return false;
    }
  }

  on<T extends PeerMessage['type']>(
    type: T,
    handler: (msg: Extract<PeerMessage, { type: T }>) => void,
  ): () => void {
    let handlers = this.#handlers.get(type);
    if (!handlers) this.#handlers.set(type, (handlers = new Set()));
    handlers.add(handler as Handler);
    return () => handlers.delete(handler as Handler);
  }

  async opened(): Promise<void> {
    await this.#open();
  }

  async sendFile(file: Outgoing, onProgress?: Progress): Promise<void> {
    await send(await this.#open(), file, onProgress);
  }

  async receiveFiles(onFile: (file: Incoming) => void, onProgress?: Progress): Promise<never> {
    const channel = await this.#open();
    return new Promise((_, reject) => listen(channel, { onFile, onProgress, onError: reject }));
  }

  /**
   * The channel, once it is actually usable.
   *
   * Only when open: a channel exists from the moment it is created, and
   * sending down one that is still connecting throws mid-transfer.
   */
  #open(): Promise<RTCDataChannel> {
    if (this.#closed) return Promise.reject(new Error(CLOSED_ERROR));
    return new Promise((resolve, reject) => {
      this.#waiting.add({ resolve, reject });
      this.#settle();
    });
  }

  /** Answer everyone waiting, if the channel has made its mind up. */
  #settle(): void {
    const channel = this.#channel;
    if (!channel || channel.readyState === 'connecting') return;
    const waiting = [...this.#waiting];
    this.#waiting.clear();
    for (const waiter of waiting) {
      if (channel.readyState === 'open') waiter.resolve(channel);
      else waiter.reject(new Error(CLOSED_ERROR));
    }
  }

  /** Parsed once here, however many features are listening. */
  #dispatch(data: unknown): void {
    const msg = parsePeerMessage(data);
    if (!msg) return;
    for (const handler of [...(this.#handlers.get(msg.type) ?? [])]) {
      (handler as (msg: PeerMessage) => void)(msg);
    }
  }
}
