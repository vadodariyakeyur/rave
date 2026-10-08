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

/** One entry in the playlist, as every member sees it. */
export interface Track {
  /** Minted by the creator's device. Names the track on this wire and nowhere else. */
  id: string;
  title: string;
  byteLength: number;
}

/**
 * Creator -> peers. The whole playlist, in order, resent whenever it changes
 * and to each member as they arrive. Whole rather than a diff for the same
 * reason the roster is: a missed message cannot leave a phantom track.
 */
export interface PlaylistMessage {
  type: 'playlist';
  tracks: Track[];
}

/**
 * Creator -> peers. This is the track about to be played: get it ready.
 *
 * Separate from `play` because getting ready takes real time — the track is
 * held encoded and has to be decoded — and every device can do that at once
 * instead of each starting only when told to already be playing.
 */
export interface SelectCue {
  type: 'select';
  trackId: string;
}

/** Creator -> peers. Play this track from `fromSeconds` at `startAt`. */
export interface PlayCue {
  type: 'play';
  trackId: string;
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

/** Creator -> peers. Stop now and go back to the start. Nothing to land on, so no instant. */
export interface StopCue {
  type: 'stop';
}

export type Cue = PlayCue | PauseCue | StopCue;

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

export type PeerMessage = Cue | SelectCue | PlaylistMessage | ClockPing | ClockPong;

type Fields = Record<string, unknown>;
const numbers = (...keys: string[]) => (msg: Fields) => keys.every((key) => typeof msg[key] === 'number');
const isTrack = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Fields).id === 'string' &&
  typeof (value as Fields).title === 'string' &&
  typeof (value as Fields).byteLength === 'number';

/** What each message must carry to be believed. */
const VALID: Record<PeerMessage['type'], (msg: Fields) => boolean> = {
  playlist: (msg) => Array.isArray(msg.tracks) && msg.tracks.every(isTrack),
  select: (msg) => typeof msg.trackId === 'string',
  play: (msg) => typeof msg.trackId === 'string' && numbers('startAt', 'fromSeconds')(msg),
  pause: numbers('pauseAt'),
  stop: () => true,
  'clock-ping': numbers('id', 't0'),
  'clock-pong': numbers('id', 't0', 't1', 't2'),
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
  const msg = value as Fields;
  const valid =
    typeof msg.type === 'string' && Object.hasOwn(VALID, msg.type)
      ? VALID[msg.type as PeerMessage['type']]
      : undefined;
  return valid?.(msg) ? (msg as unknown as PeerMessage) : undefined;
}
