import { randomUUID, randomInt } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type Peer,
  type RoomState,
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
  durationSeconds: number;
  peers: Peer[];
  locked: boolean;
}

export interface CreateRoomInput {
  roomName: string;
  displayName: string;
  durationSeconds: number;
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

  create(input: CreateRoomInput): Room {
    const creator: Peer = {
      peerId: randomUUID(),
      displayName: input.displayName,
      isCreator: true,
      // The creator picked the file and decoded it before we got here.
      ready: true,
    };

    const room: Room = {
      code: this.#uniqueCode(),
      roomName: input.roomName,
      createdAt: new Date().toISOString(),
      durationSeconds: input.durationSeconds,
      peers: [creator],
      locked: false,
    };

    this.#byCode.set(room.code, room);
    this.#roomCodeByPeer.set(creator.peerId, room.code);
    return room;
  }

  get(code: string): Room | undefined {
    return this.#byCode.get(code);
  }

  roomForPeer(peerId: string): Room | undefined {
    const code = this.#roomCodeByPeer.get(peerId);
    return code === undefined ? undefined : this.#byCode.get(code);
  }

  /**
   * Remove a peer. If they were the creator the whole room goes with them:
   * the creator is the clock master, so the room cannot play without one.
   */
  removePeer(peerId: string): Room | undefined {
    const room = this.roomForPeer(peerId);
    this.#roomCodeByPeer.delete(peerId);
    if (!room) return undefined;

    const peer = room.peers.find((p) => p.peerId === peerId);
    room.peers = room.peers.filter((p) => p.peerId !== peerId);

    if (peer?.isCreator || room.peers.length === 0) {
      for (const p of room.peers) this.#roomCodeByPeer.delete(p.peerId);
      this.#byCode.delete(room.code);
      return undefined;
    }
    return room;
  }

  /** The room as clients see it. */
  toState(room: Room): RoomState {
    return {
      type: 'room-state',
      code: room.code,
      roomName: room.roomName,
      peers: room.peers,
      locked: room.locked,
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
