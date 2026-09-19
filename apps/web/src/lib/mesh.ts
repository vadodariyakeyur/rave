'use client';

import type { IceServer, Peer, ServerMessage } from '@rave/protocol';
import type { Signaling } from './signaling';

/**
 * The WebRTC mesh: one RTCPeerConnection per other peer in the room.
 *
 * The signaling server relays SDP and ICE by peer id and reads neither. Once
 * a connection is up, nothing else about it touches the server — which is the
 * whole point: the file and the clock go over these channels in #5 and #6.
 */

/**
 * What the roster shows. RTCPeerConnectionState has five values and two of
 * them ('new', 'connecting') mean the same thing to a person waiting, so they
 * collapse — but 'failed' stays distinct from 'closed', because one is worth
 * telling someone about and the other is just a peer who left.
 */
export type PeerConnectionState = 'connecting' | 'connected' | 'failed' | 'closed';

/**
 * How long a connection may sit in 'connecting' before it is called failed.
 *
 * ICE does not always reach 'failed' on its own: if no candidate pair can be
 * formed at all, it stays in checking forever and connectionstatechange
 * never fires again. Without this a peer shows 'connecting' indefinitely and
 * the host waits on someone who is never arriving. On a LAN a connection
 * that has not landed in 15s is not going to.
 */
const CONNECT_TIMEOUT_MS = 15_000;

interface Connection {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  timeout?: ReturnType<typeof setTimeout>;
  /**
   * ICE candidates that arrived before the remote description did. Setting a
   * candidate without one throws, and the relay makes no ordering promise —
   * an answer and its candidates race, and on a LAN the candidates often win.
   */
  pendingCandidates: RTCIceCandidateInit[];
}

export class Mesh {
  readonly #signaling: Signaling;
  readonly #iceServers: IceServer[];
  readonly #selfPeerId: string;
  readonly #connections = new Map<string, Connection>();
  readonly #states = new Map<string, PeerConnectionState>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;

  constructor(input: { signaling: Signaling; selfPeerId: string; iceServers: IceServer[] }) {
    this.#signaling = input.signaling;
    this.#selfPeerId = input.selfPeerId;
    this.#iceServers = input.iceServers;
    this.#unsubscribe = input.signaling.onMessage((msg) => {
      if (msg.type === 'signal') this.#negotiate(msg.from, () => this.#onSignal(msg));
    });
  }

  /** Per-peer connection state, for the roster. */
  states(): ReadonlyMap<string, PeerConnectionState> {
    return this.#states;
  }

  /**
   * This peer's DataChannel, once it is actually usable.
   *
   * Only when open: a channel exists from the moment it is created, and
   * sending down one that is still connecting throws mid-transfer. The
   * caller retries on the next notify rather than guarding this itself.
   */
  channel(peerId: string): RTCDataChannel | undefined {
    const channel = this.#connections.get(peerId)?.channel;
    return channel?.readyState === 'open' ? channel : undefined;
  }

  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Reconcile against the roster: open connections to peers that are new,
   * tear down connections to peers that have gone.
   *
   * Driven by room-state rather than by join/leave events because the roster
   * is the server's own truth — a missed event would leave a phantom peer in
   * the mesh forever, whereas a missed reconcile self-corrects on the next one.
   */
  sync(peers: readonly Peer[]): void {
    const present = new Set(peers.map((p) => p.peerId));

    for (const peerId of this.#connections.keys()) {
      if (!present.has(peerId)) this.#teardown(peerId);
    }

    for (const peer of peers) {
      if (peer.peerId === this.#selfPeerId) continue;
      if (this.#connections.has(peer.peerId)) continue;
      // Both sides see the same roster at the same moment, so both would
      // offer. Comparing ids picks one deterministically without another
      // round trip; the other side waits for the offer to arrive.
      this.#connect(peer.peerId, this.#selfPeerId < peer.peerId);
    }
  }

  /** Drop every connection. Called when the room ends or the page unmounts. */
  close(): void {
    this.#unsubscribe();
    for (const peerId of [...this.#connections.keys()]) this.#teardown(peerId);
  }

  #connect(peerId: string, initiator: boolean): Connection {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers as RTCIceServer[] });
    const connection: Connection = { pc, pendingCandidates: [] };
    this.#connections.set(peerId, connection);
    this.#setState(peerId, 'connecting');

    pc.addEventListener('icecandidate', (event) => {
      // A null candidate is the end-of-gathering marker, not an address.
      if (event.candidate) this.#send(peerId, { candidate: event.candidate.toJSON() });
    });

    pc.addEventListener('connectionstatechange', () => {
      this.#setState(peerId, TO_STATE[pc.connectionState]);
    });

    connection.timeout = setTimeout(() => {
      if (this.#states.get(peerId) !== 'connected') this.#setState(peerId, 'failed');
    }, CONNECT_TIMEOUT_MS);

    if (initiator) {
      // Negotiation is driven by the negotiationneeded event rather than
      // called inline: creating the channel below fires it, and so would any
      // later track or channel, so one path covers renegotiation too.
      pc.addEventListener('negotiationneeded', () =>
        this.#negotiate(peerId, () => this.#offer(peerId)),
      );
      // Spelled out rather than left to the default: #5 sends the audio file
      // over this and #6 the clock probes, and both break silently under
      // partial reliability. An explicit option is also something a test can
      // hold onto.
      connection.channel = pc.createDataChannel('rave', { ordered: true });
      this.#watchChannel(connection.channel);
    } else {
      pc.addEventListener('datachannel', (event) => {
        connection.channel = event.channel;
        this.#watchChannel(event.channel);
      });
    }

    return connection;
  }

  /**
   * Run one step of negotiation, reporting a throw as a failed connection.
   *
   * Every SDP call can reject — glare, a peer that closed mid-negotiation, an
   * offer that arrived after a rejoin. Unhandled, the peer sits at
   * 'connecting' with nothing on screen saying why, which is the failure the
   * timeout exists to prevent; past the timeout, it sits there forever.
   */
  #negotiate(peerId: string, step: () => Promise<void>): void {
    void step().catch(() => {
      // Only if the connection is still ours: a teardown mid-flight is an
      // ordinary cancellation, not a failure worth showing.
      if (this.#connections.has(peerId)) this.#setState(peerId, 'failed');
    });
  }

  async #offer(peerId: string): Promise<void> {
    const connection = this.#connections.get(peerId);
    if (!connection) return;
    const offer = await connection.pc.createOffer();
    await connection.pc.setLocalDescription(offer);
    this.#send(peerId, { description: connection.pc.localDescription?.toJSON() });
  }

  async #onSignal(msg: Extract<ServerMessage, { type: 'signal' }>): Promise<void> {
    const payload = msg.data as SignalPayload | null;
    if (!payload) return;

    // An offer can arrive before our own roster update does, so a connection
    // is created on demand here rather than assumed to exist.
    const connection =
      this.#connections.get(msg.from) ?? this.#connect(msg.from, false);

    if (payload.description) {
      await connection.pc.setRemoteDescription(payload.description);
      // Only now can queued candidates be applied.
      for (const candidate of connection.pendingCandidates.splice(0)) {
        await connection.pc.addIceCandidate(candidate).catch(() => {});
      }
      if (payload.description.type === 'offer') {
        await connection.pc.setLocalDescription(await connection.pc.createAnswer());
        this.#send(msg.from, { description: connection.pc.localDescription?.toJSON() });
      }
      return;
    }

    if (payload.candidate) {
      if (!connection.pc.remoteDescription) {
        connection.pendingCandidates.push(payload.candidate);
        return;
      }
      // A candidate for a path that is already dead rejects, and that is not
      // an error worth surfacing — connectionstatechange reports the outcome.
      await connection.pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  }

  /**
   * A channel opens after connectionstatechange has already said 'connected',
   * so nothing else announces the one moment a transfer may begin.
   */
  #watchChannel(channel: RTCDataChannel): void {
    if (channel.readyState === 'open') return this.#notify();
    channel.addEventListener('open', () => this.#notify());
  }

  #send(peerId: string, payload: SignalPayload): void {
    this.#signaling.send({ type: 'signal', to: peerId, data: payload });
  }

  #teardown(peerId: string): void {
    const connection = this.#connections.get(peerId);
    if (!connection) return;
    if (connection.timeout) clearTimeout(connection.timeout);
    connection.channel?.close();
    connection.pc.close();
    this.#connections.delete(peerId);
    // The peer is out of the roster entirely, so a 'closed' row would be a
    // row for someone who is not there. Drop it.
    this.#states.delete(peerId);
    this.#notify();
  }

  #setState(peerId: string, state: PeerConnectionState): void {
    if (state === 'connected') {
      const connection = this.#connections.get(peerId);
      if (connection?.timeout) {
        clearTimeout(connection.timeout);
        connection.timeout = undefined;
      }
    }
    if (this.#states.get(peerId) === state) return;
    this.#states.set(peerId, state);
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** What we put in the opaque `data` of a signal. Ours on both ends. */
interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const TO_STATE: Record<RTCPeerConnectionState, PeerConnectionState> = {
  new: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'connecting',
  failed: 'failed',
  closed: 'closed',
};
