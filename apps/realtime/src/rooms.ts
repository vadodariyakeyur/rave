import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ErrorMessage,
  type Mode,
  type Peer,
  type RoomClosed,
  type RoomState,
  type RoomSummary,
} from '@rave/protocol';

/**
 * In-memory room registry.
 *
 * Rooms die on restart. That is accepted for this phase: a room only outlives
 * a single listening session by accident, and persisting them would mean
 * reconciling peers whose sockets are already gone.
 */

export interface Room {
  code: string;
  roomName: string;
  /** UTC ISO-8601. For humans and logs; never used for scheduling. */
  createdAt: string;
  description: string;
  /** Held here and nowhere else: it is checked on join and never sent out. */
  passcode?: string;
  /** Music until the creator switches it. */
  mode: Mode;
  /** What the creator says is playing. Display only, for the room list. */
  nowPlaying: string | null;
  peers: Peer[];
}

/**
 * Why a result and not an exception: every refusal is an ordinary outcome of
 * someone typing a code or a passcode, and the reason maps straight onto a
 * wire error code.
 */
export type JoinResult =
  | { ok: true; room: Room; peerId: string }
  | {
      ok: false;
      reason: Extract<ErrorMessage['code'], 'room-not-found' | 'passcode-required' | 'passcode-wrong'>;
    };

/** Whether a kick took, and from which room. */
export type KickResult =
  | { ok: true; room: Room }
  | { ok: false; reason: Extract<ErrorMessage['code'], 'not-creator' | 'peer-not-found'> };

/** What became of the room after a peer left. */
export type RemoveResult =
  | { kind: 'open'; room: Room }
  | { kind: 'closed'; code: string; reason: RoomClosed['reason'] }
  | { kind: 'unknown' };

export interface CreateRoomInput {
  roomName: string;
  displayName: string;
  description?: string;
  passcode?: string;
}

/** A room code with the ambiguous characters already excluded by the alphabet. */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    // randomInt over Math.random: codes are guessable room handles, and a
    // predictable generator lets someone walk into a stranger's room.
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export class RoomRegistry {
  readonly #byCode = new Map<string, Room>();
  /** Reverse index so a dropped socket can find its room in one step. */
  readonly #roomCodeByPeer = new Map<string, string>();

  get size(): number {
    return this.#byCode.size;
  }

  /** Everyone currently in a room, across all of them. */
  get peerCount(): number {
    let total = 0;
    for (const room of this.#byCode.values()) total += room.peers.length;
    return total;
  }

  create(input: CreateRoomInput): Room {
    const creator: Peer = {
      peerId: randomUUID(),
      displayName: input.displayName,
      isCreator: true,
    };

    const room: Room = {
      code: this.#uniqueCode(),
      roomName: input.roomName,
      createdAt: new Date().toISOString(),
      description: input.description ?? '',
      passcode: input.passcode,
      mode: 'music',
      nowPlaying: null,
      peers: [creator],
    };

    this.#byCode.set(room.code, room);
    this.#roomCodeByPeer.set(creator.peerId, room.code);
    return room;
  }

  /**
   * Add a peer to a room, at any point in its life: there is no lock, and
   * someone arriving mid-track starts in sync from wherever the room is.
   */
  join(code: string, displayName: string, passcode?: string): JoinResult {
    const room = this.#byCode.get(code);
    if (!room) return { ok: false, reason: 'room-not-found' };
    if (room.passcode !== undefined) {
      // Two refusals, because the screen does two different things: ask for
      // one, or say the one it was given is wrong.
      if (passcode === undefined) return { ok: false, reason: 'passcode-required' };
      if (!samePasscode(room.passcode, passcode)) return { ok: false, reason: 'passcode-wrong' };
    }

    const peer: Peer = { peerId: randomUUID(), displayName, isCreator: false };
    room.peers.push(peer);
    this.#roomCodeByPeer.set(peer.peerId, room.code);
    return { ok: true, room, peerId: peer.peerId };
  }

  get(code: string): Room | undefined {
    return this.#byCode.get(code);
  }

  roomForPeer(peerId: string): Room | undefined {
    const code = this.#roomCodeByPeer.get(peerId);
    return code === undefined ? undefined : this.#byCode.get(code);
  }

  /**
   * The creator removes a member. Only from the creator's own room, and
   * never the creator themselves — that is leaving, and it ends the room.
   *
   * Nothing is remembered: a kicked member can join again.
   */
  kick(creatorId: string, peerId: string): KickResult {
    const room = this.roomForPeer(creatorId);
    if (!room?.peers.some((p) => p.peerId === creatorId && p.isCreator)) {
      return { ok: false, reason: 'not-creator' };
    }
    if (peerId === creatorId || !room.peers.some((p) => p.peerId === peerId)) {
      return { ok: false, reason: 'peer-not-found' };
    }
    room.peers = room.peers.filter((p) => p.peerId !== peerId);
    this.#roomCodeByPeer.delete(peerId);
    return { ok: true, room };
  }

  /** What the creator says is playing. Undefined if they are not a creator. */
  setNowPlaying(creatorId: string, title: string | null): Room | undefined {
    const room = this.roomForPeer(creatorId);
    if (!room?.peers.some((p) => p.peerId === creatorId && p.isCreator)) return undefined;
    room.nowPlaying = title;
    return room;
  }

  /** The creator switches the room's mode. Undefined if they are not a creator. */
  setMode(creatorId: string, mode: Mode): Room | undefined {
    const room = this.roomForPeer(creatorId);
    if (!room?.peers.some((p) => p.peerId === creatorId && p.isCreator)) return undefined;
    room.mode = mode;
    return room;
  }

  /** Every live room, as the homepage lists it. */
  list(): RoomSummary[] {
    return [...this.#byCode.values()].map((room) => ({
      code: room.code,
      roomName: room.roomName,
      description: room.description,
      memberCount: room.peers.length,
      hasPasscode: room.passcode !== undefined,
      mode: room.mode,
      nowPlaying: room.nowPlaying,
    }));
  }

  /**
   * Remove a peer. If they were the creator the whole room goes with them:
   * the creator is the clock master, so the room cannot play without one.
   *
   * Why a tagged result: 'gone' has two causes, and the survivors are told
   * which one. Collapsing them into a bare undefined is what made the server
   * blame the host for a room that simply emptied.
   */
  removePeer(peerId: string): RemoveResult {
    const room = this.roomForPeer(peerId);
    this.#roomCodeByPeer.delete(peerId);
    if (!room) return { kind: 'unknown' };

    const peer = room.peers.find((p) => p.peerId === peerId);
    room.peers = room.peers.filter((p) => p.peerId !== peerId);

    if (peer?.isCreator || room.peers.length === 0) {
      for (const p of room.peers) this.#roomCodeByPeer.delete(p.peerId);
      this.#byCode.delete(room.code);
      return { kind: 'closed', code: room.code, reason: peer?.isCreator ? 'creator-left' : 'room-empty' };
    }
    return { kind: 'open', room };
  }

  /** The room as clients see it. */
  toState(room: Room): RoomState {
    return {
      type: 'room-state',
      code: room.code,
      roomName: room.roomName,
      description: room.description,
      mode: room.mode,
      peers: room.peers,
    };
  }

  #uniqueCode(): string {
    // The space is 31^6 (~887M), so a collision is rare, but "rare" across a
    // long-running process is not "never" — and a collision would silently
    // hand someone another room.
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = generateRoomCode();
      if (!this.#byCode.has(code)) return code;
    }
    throw new Error('exhausted room code attempts');
  }
}

/** Constant-time, so a wrong guess does not say how much of it was right. */
function samePasscode(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
