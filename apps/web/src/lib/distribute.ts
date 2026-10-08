'use client';

import type { PeerLink } from './link';
import type { Outgoing, Transfer } from './transfer';

/** Reaching peers by id. The mesh, as far as the files are concerned. */
export interface Links {
  link(peerId: string): PeerLink;
}

/** One member's place in the queue. */
interface Sending {
  /** Tracks handed over in full. */
  sent: Set<string>;
  /** The track on the wire now, and how much of it has gone. */
  current?: { trackId: string; fraction: number };
  stalled: boolean;
}

/**
 * The creator's side of the playlist: every track to every member.
 *
 * One file at a time per member, in playlist order, each started the moment
 * the one before it is through — the link holds the first until the member
 * can take it. A track added later joins the back of everyone's queue; one
 * removed before its turn is never sent.
 */
export class Distributor {
  readonly #links: Links;
  readonly #members = new Map<string, Sending>();
  readonly #listeners = new Set<() => void>();
  #tracks: readonly Outgoing[] = [];
  #closed = false;

  constructor(links: Links) {
    this.#links = links;
  }

  /** What the roster renders, per member. Empty while the playlist is. */
  transfers(): ReadonlyMap<string, Transfer> {
    const total = this.#tracks.reduce((sum, t) => sum + t.bytes.byteLength, 0);
    const out = new Map<string, Transfer>();
    if (this.#tracks.length === 0) return out;
    for (const [peerId, member] of this.#members) {
      let done = 0;
      for (const track of this.#tracks) {
        if (member.sent.has(track.trackId)) done += track.bytes.byteLength;
        else if (member.current?.trackId === track.trackId) {
          done += track.bytes.byteLength * member.current.fraction;
        }
      }
      const all = this.#tracks.every((t) => member.sent.has(t.trackId));
      out.set(peerId, {
        progress: total === 0 ? 1 : done / total,
        state: member.stalled ? 'stalled' : all ? 'sent' : 'downloading',
      });
    }
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The playlist, in order, on every change to it. */
  setTracks(tracks: readonly Outgoing[]): void {
    if (this.#closed) return;
    this.#tracks = tracks;
    for (const peerId of this.#members.keys()) this.#pump(peerId);
    this.#notify();
  }

  /** Called with the roster's peer ids, minus ourselves, on every change. */
  sync(peerIds: readonly string[]): void {
    if (this.#closed) return;

    // Someone who left takes their queue with them. Rejoining gets a new
    // peer id and a clean start, which is the whole recovery story.
    const present = new Set(peerIds);
    for (const peerId of [...this.#members.keys()]) {
      if (!present.has(peerId)) this.#members.delete(peerId);
    }
    for (const peerId of peerIds) {
      if (this.#members.has(peerId)) continue;
      this.#members.set(peerId, { sent: new Set(), stalled: false });
      this.#pump(peerId);
    }
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#members.clear();
    this.#listeners.clear();
  }

  /** Start this member's next track, unless one is already on the wire. */
  #pump(peerId: string): void {
    const member = this.#members.get(peerId);
    // Mid-file or given up on: leave it. Two files at once down one channel
    // would interleave into one buffer on the other side.
    if (this.#closed || !member || member.current || member.stalled) return;
    const next = this.#tracks.find((t) => !member.sent.has(t.trackId));
    if (!next) return;
    member.current = { trackId: next.trackId, fraction: 0 };
    void this.#send(peerId, member, next);
  }

  async #send(peerId: string, member: Sending, track: Outgoing): Promise<void> {
    // A late word for a member who has since left, or after close, is dropped.
    const live = () => !this.#closed && this.#members.get(peerId) === member;
    try {
      await this.#links.link(peerId).sendFile(track, (fraction) => {
        if (!live()) return;
        member.current = { trackId: track.trackId, fraction };
        this.#notify();
      });
      if (!live()) return;
      member.sent.add(track.trackId);
      member.current = undefined;
      this.#pump(peerId);
    } catch {
      if (!live()) return;
      // Whatever went wrong — stall, close, a channel that never opened —
      // the roster says the same thing, and nothing more is sent to them.
      member.current = undefined;
      member.stalled = true;
    }
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** How one track stands on a member's device. */
export interface Download {
  /** 0 to 1. Absent before its turn has come. */
  progress?: number;
  state: 'waiting' | 'downloading' | 'ready';
}

/**
 * The member's side of the playlist: take each track as it comes.
 *
 * Tracks are kept as they arrive — encoded. Decoded audio is tens of times
 * larger, and a phone holding a whole playlist of it runs out of memory, so
 * a track is only decoded when it is about to be played.
 */
export class Receiver {
  readonly #creator: PeerLink;
  readonly #listeners = new Set<() => void>();
  readonly #bytes = new Map<string, ArrayBuffer>();
  #current: { trackId: string; progress: number } | undefined;
  #stalled = false;
  #started = false;
  #closed = false;

  constructor(creator: PeerLink) {
    this.#creator = creator;
  }

  /** The encoded track, once all of it is here. */
  bytes(trackId: string): ArrayBuffer | undefined {
    return this.#bytes.get(trackId);
  }

  /** Where one track has got to. */
  download(trackId: string): Download {
    if (this.#bytes.has(trackId)) return { progress: 1, state: 'ready' };
    if (this.#current?.trackId === trackId) {
      return { progress: this.#current.progress, state: 'downloading' };
    }
    return { state: 'waiting' };
  }

  /** The link to the creator broke mid-playlist. Nothing more will arrive. */
  stalled(): boolean {
    return this.#stalled;
  }

  /** Forget every track not in the playlist any more. */
  keep(trackIds: readonly string[]): void {
    const wanted = new Set(trackIds);
    for (const trackId of [...this.#bytes.keys()]) {
      if (!wanted.has(trackId)) this.#bytes.delete(trackId);
    }
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
    this.#bytes.clear();
  }

  async #run(): Promise<void> {
    try {
      await this.#creator.receiveFiles(
        (incoming) => {
          if (this.#closed) return;
          this.#current = undefined;
          this.#bytes.set(incoming.trackId, incoming.bytes);
          this.#notify();
        },
        (progress, trackId) => {
          this.#current = { trackId, progress };
          this.#notify();
        },
      );
    } catch {
      this.#current = undefined;
      this.#stalled = true;
      this.#notify();
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
