'use client';

import type { Ready } from '@rave/protocol';
import { decodeBytes } from './audio';
import type { Mesh } from './mesh';
import { receive, send, type Outgoing, type Transfer } from './transfer';

/**
 * The creator's side of the barrier: who has the file, and how far along.
 *
 * One send per peer, started the moment that peer's channel opens and never
 * restarted while it is in flight. The roster reads {@link transfers} and the
 * Play button reads the same map — both are looking at this, not at the
 * server, because progress is a fact about a DataChannel the server cannot
 * see.
 */
export class Distributor {
  readonly #mesh: Pick<Mesh, 'channel' | 'subscribe'>;
  readonly #file: Outgoing;
  readonly #transfers = new Map<string, Transfer>();
  /**
   * Peers a send has been started for. Separate from #transfers, which now
   * holds a row for a peer whose channel has not opened yet — that row must
   * not be mistaken for a transfer already under way.
   */
  readonly #sending = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  /** Peers currently in the roster, so a mesh notify knows who to serve. */
  #peerIds: readonly string[] = [];
  #closed = false;

  constructor(mesh: Pick<Mesh, 'channel' | 'subscribe'>, file: Outgoing) {
    this.#mesh = mesh;
    this.#file = file;
    // A channel opens after the roster already listed its peer, so the mesh
    // notify — not sync — is what usually starts a transfer.
    this.#unsubscribe = mesh.subscribe(() => this.#pump());
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
    this.#peerIds = [...peerIds];

    // Someone who left takes their transfer with them. Rejoining gets a new
    // peer id and a clean start, which is the whole recovery story.
    const present = new Set(peerIds);
    for (const peerId of [...this.#transfers.keys()]) {
      if (present.has(peerId)) continue;
      this.#transfers.delete(peerId);
      // The guard goes with it: without this a peer who left and came back
      // on the same id would never be sent to again.
      this.#sending.delete(peerId);
    }
    this.#pump();
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.#transfers.clear();
    this.#sending.clear();
    this.#listeners.clear();
  }

  /** Start a send for every peer that needs one and can take one. */
  #pump(): void {
    if (this.#closed) return;
    for (const peerId of this.#peerIds) {
      // Every peer in the roster has an entry from the moment they appear,
      // even before their channel exists: the roster has a row to render and
      // the barrier has someone to wait for. Absent would read as neither.
      if (!this.#transfers.has(peerId)) {
        this.#transfers.set(peerId, { progress: 0, state: 'downloading' });
      }
      // In flight, done, or given up on: leave it. Restarting a live
      // transfer would interleave two streams into one buffer.
      if (this.#sending.has(peerId)) continue;
      const channel = this.#mesh.channel(peerId);
      if (!channel) continue;
      this.#sending.add(peerId);
      void this.#send(peerId, channel);
    }
    this.#notify();
  }

  async #send(peerId: string, channel: RTCDataChannel): Promise<void> {
    try {
      await send(channel, this.#file, (progress) => this.#set(peerId, { progress, state: 'downloading' }));
      // Sent, not ready: see Transfer. The peer's own `ready` is what the
      // barrier reads, and it only arrives once they have decoded it.
      this.#set(peerId, { progress: 1, state: 'sent' });
    } catch {
      // Whatever went wrong — stall, close, a channel that was never really
      // open — the roster says the same thing and the barrier stops waiting.
      this.#set(peerId, { progress: this.#transfers.get(peerId)?.progress ?? 0, state: 'stalled' });
    }
  }

  /** Ignore a late update for a peer who has since left, or after close. */
  #set(peerId: string, transfer: Transfer): void {
    if (this.#closed || !this.#transfers.has(peerId)) return;
    this.#transfers.set(peerId, transfer);
    this.#notify();
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

/** The part of Session a Receiver needs, kept narrow so it is testable. */
interface ReceiverSession {
  audioContext: AudioContext;
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
  readonly #mesh: Pick<Mesh, 'channel' | 'subscribe'>;
  readonly #creatorId: string;
  readonly #session: ReceiverSession;
  readonly #listeners = new Set<() => void>();
  #transfer: Transfer = { progress: 0, state: 'downloading' };
  #result: Received | undefined;
  #unsubscribe: (() => void) | undefined;
  #started = false;

  constructor(
    mesh: Pick<Mesh, 'channel' | 'subscribe'>,
    creatorId: string,
    session: ReceiverSession,
  ) {
    this.#mesh = mesh;
    this.#creatorId = creatorId;
    this.#session = session;
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
   * Begin listening. The creator's channel usually does not exist yet, so
   * this waits on the mesh rather than failing.
   */
  start(): void {
    if (this.#unsubscribe || this.#started) return;
    this.#unsubscribe = this.#mesh.subscribe(() => this.#attach());
    this.#attach();
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#listeners.clear();
  }

  #attach(): void {
    if (this.#started) return;
    const channel = this.#mesh.channel(this.#creatorId);
    if (!channel) return;
    this.#started = true;
    // Only the mesh wait is over; the download itself is still ahead.
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    void this.#run(channel);
  }

  async #run(channel: RTCDataChannel): Promise<void> {
    try {
      const incoming = await receive(channel, (progress) =>
        this.#set({ progress, state: 'downloading' }),
      );
      // Decode before announcing: this is the step that decides whether this
      // device can play at all.
      const decoded = await decodeBytes(this.#session.audioContext, incoming.bytes);
      this.#result = {
        buffer: decoded.buffer,
        fileName: incoming.fileName,
        bytes: incoming.bytes,
      };
      this.#set({ progress: 1, state: 'ready' });
      this.#session.signaling.send({ type: 'ready' });
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
