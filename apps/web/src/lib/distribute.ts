'use client';

import type { Ready } from '@rave/protocol';
import { decodeBytes } from './audio';
import type { PeerLink } from './link';
import type { Outgoing, Transfer } from './transfer';

/** Reaching peers by id. The mesh, as far as the file is concerned. */
export interface Links {
  link(peerId: string): PeerLink;
}

/**
 * The creator's side of the barrier: who has the file, and how far along.
 *
 * One send per peer, started the moment that peer appears — the link holds
 * it until the peer can take it — and never restarted while it is in flight.
 * The roster reads {@link transfers} and the Play button reads the same map —
 * both are looking at this, not at the server, because progress is a fact
 * about a DataChannel the server cannot see.
 */
export class Distributor {
  readonly #links: Links;
  readonly #file: Outgoing;
  readonly #transfers = new Map<string, Transfer>();
  /**
   * The send each peer's row belongs to. A peer who left and came back has
   * a new row, and a late word from the old send must not land on it.
   */
  readonly #sends = new Map<string, object>();
  readonly #listeners = new Set<() => void>();
  #closed = false;

  constructor(links: Links, file: Outgoing) {
    this.#links = links;
    this.#file = file;
  }

  /** What the roster renders, per peer id. */
  transfers(): ReadonlyMap<string, Transfer> {
    return this.#transfers;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called with the roster's peer ids, minus ourselves, on every change. */
  sync(peerIds: readonly string[]): void {
    if (this.#closed) return;

    // Someone who left takes their transfer with them. Rejoining gets a new
    // peer id and a clean start, which is the whole recovery story.
    const present = new Set(peerIds);
    for (const peerId of [...this.#transfers.keys()]) {
      if (present.has(peerId)) continue;
      this.#transfers.delete(peerId);
      this.#sends.delete(peerId);
    }

    for (const peerId of peerIds) {
      // In flight, done, or given up on: leave it. Restarting a live
      // transfer would interleave two streams into one buffer.
      if (this.#sends.has(peerId)) continue;
      // A row from the moment they appear, even before their channel
      // exists: the roster has something to render and the barrier has
      // someone to wait for. Absent would read as neither.
      this.#transfers.set(peerId, { progress: 0, state: 'downloading' });
      const send = {};
      this.#sends.set(peerId, send);
      void this.#send(peerId, send);
    }
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#transfers.clear();
    this.#sends.clear();
    this.#listeners.clear();
  }

  async #send(peerId: string, send: object): Promise<void> {
    /** Ignore a late update for a peer who has since left, or after close. */
    const set = (transfer: Transfer) => {
      if (this.#closed || this.#sends.get(peerId) !== send) return;
      this.#transfers.set(peerId, transfer);
      this.#notify();
    };
    try {
      await this.#links
        .link(peerId)
        .sendFile(this.#file, (progress) => set({ progress, state: 'downloading' }));
      // Sent, not ready: see Transfer. The peer's own `ready` is what the
      // barrier reads, and it only arrives once they have decoded it.
      set({ progress: 1, state: 'sent' });
    } catch {
      // Whatever went wrong — stall, close, a channel that never opened —
      // the roster says the same thing and the barrier stops waiting.
      set({ progress: this.#transfers.get(peerId)?.progress ?? 0, state: 'stalled' });
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** What a joiner ends up with: the decoded track, plus the bytes to re-serve. */
export interface Received {
  buffer: AudioBuffer;
  fileName: string;
  bytes: ArrayBuffer;
}

/** What a Receiver needs of the room, kept narrow so it is testable. */
interface ReceiverRoom {
  audioContext: Pick<AudioContext, 'decodeAudioData'>;
  signaling: { send: (msg: Ready) => void };
}

/**
 * The joiner's side of the barrier: download from the creator, decode, then
 * say ready — in that order, and only in that order.
 *
 * Ready means "this device can actually play it". A file that arrived but
 * would not decode is stalled: claiming ready there produces a device that
 * is silent at playback with nothing on screen explaining why.
 */
export class Receiver {
  readonly #creator: PeerLink;
  readonly #room: ReceiverRoom;
  readonly #listeners = new Set<() => void>();
  #transfer: Transfer = { progress: 0, state: 'downloading' };
  #result: Received | undefined;
  #started = false;
  #closed = false;

  constructor(creator: PeerLink, room: ReceiverRoom) {
    this.#creator = creator;
    this.#room = room;
  }

  transfer(): Transfer {
    return this.#transfer;
  }

  /** The decoded track, once there is one. */
  result(): Received | undefined {
    return this.#result;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Begin listening. The creator's channel usually does not exist yet; the
   * link waits for it rather than failing.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#run();
  }

  /** Stop reporting. A download in flight finishes into nothing. */
  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  async #run(): Promise<void> {
    try {
      const incoming = await this.#creator.receiveFile((progress) =>
        this.#set({ progress, state: 'downloading' }),
      );
      // Decode before announcing: this is the step that decides whether this
      // device can play at all.
      const decoded = await decodeBytes(this.#room.audioContext, incoming.bytes);
      // The room ended while this was decoding. Nobody is waiting on it.
      if (this.#closed) return;
      this.#result = {
        buffer: decoded.buffer,
        fileName: incoming.fileName,
        bytes: incoming.bytes,
      };
      // Listeners first: whoever plays the track has it in hand before the
      // room is told this device is ready to be cued.
      this.#set({ progress: 1, state: 'ready' });
      this.#room.signaling.send({ type: 'ready' });
    } catch {
      // Dropped, stalled or undecodable — all the same to the roster, and
      // none of them are ready.
      this.#set({ progress: this.#transfer.progress, state: 'stalled' });
    }
  }

  #set(transfer: Transfer): void {
    this.#transfer = transfer;
    for (const listener of [...this.#listeners]) listener();
  }
}
