/**
 * The peer wire: everything two browsers say to each other directly.
 *
 * The counterpart of the protocol package, which is the wire to the server.
 * This one never touches the server — it rides the DataChannel the mesh
 * opened — and it is the one the timing travels on, so it has one definition
 * and one parser rather than a narrowing function per feature.
 *
 * The file itself is not in here: its header and chunks are framing private
 * to transfer.ts, and anything this parser does not recognise is simply not
 * a message, which is what lets the two share a channel.
 */

/** Creator -> peers. Play this buffer from `fromSeconds` at `startAt`. */
export interface PlayCue {
  type: 'play';
  /** The creator's monotonic clock. Meaningless here until offset-corrected. */
  startAt: number;
  /** Where in the track to start. Non-zero when resuming from a pause. */
  fromSeconds: number;
}

/** Creator -> peers. Stop at this instant, everyone on the same sample. */
export interface PauseCue {
  type: 'pause';
  /** The creator's monotonic clock. */
  pauseAt: number;
}

export type Cue = PlayCue | PauseCue;

/** Probe, peer -> creator. `id` comes back untouched so the reply can be matched. */
export interface ClockPing {
  type: 'clock-ping';
  id: number;
  /** The sender's own monotonic clock. Meaningless to the receiver, echoed back. */
  t0: number;
}

/** Reply, creator -> peer. t1 and t2 are both the creator's clock. */
export interface ClockPong {
  type: 'clock-pong';
  id: number;
  t0: number;
  /** When the creator saw the ping. */
  t1: number;
  /** When the creator sent this reply. Not equal to t1: serialising takes time. */
  t2: number;
}

export type PeerMessage = Cue | ClockPing | ClockPong;

/** The numeric fields each message must carry to be believed. */
const FIELDS: Record<PeerMessage['type'], readonly string[]> = {
  play: ['startAt', 'fromSeconds'],
  pause: ['pauseAt'],
  'clock-ping': ['id', 't0'],
  'clock-pong': ['id', 't0', 't1', 't2'],
};

/**
 * Narrow whatever arrived on a channel to a peer message. Never throws.
 *
 * Undefined for a file chunk, a file header, malformed JSON, or a message
 * missing a field: on a shared channel "not ours" is the ordinary case.
 */
export function parsePeerMessage(data: unknown): PeerMessage | undefined {
  if (typeof data !== 'string') return undefined; // A file chunk. Not ours.
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const msg = value as Record<string, unknown>;
  const fields = typeof msg.type === 'string' && Object.hasOwn(FIELDS, msg.type)
    ? FIELDS[msg.type as PeerMessage['type']]
    : undefined;
  if (!fields || !fields.every((key) => typeof msg[key] === 'number')) return undefined;
  return msg as unknown as PeerMessage;
}
