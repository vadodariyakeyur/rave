import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, ServerMessage } from '@rave/protocol';
import { RoomHub, type Outcome } from './hub.ts';
import { Metrics } from './metrics.ts';
import { RoomRegistry } from './rooms.ts';

/**
 * The hub's own rule: a roster change reaches the whole room and moves the
 * barrier timer, on every path, without the path having to say so. No socket
 * anywhere — what comes out is who must hear what.
 */

function hub() {
  const rooms = new RoomRegistry();
  const metrics = new Metrics(rooms);
  let t = 0;
  const built = new RoomHub({ rooms, metrics, now: () => t });
  return {
    hub: built,
    advance: (ms: number) => {
      t += ms;
    },
    /** How many barriers were recorded, and their total wait. */
    async barrier(): Promise<{ count: number; sum: number }> {
      const { body } = await metrics.render();
      const read = (suffix: string) =>
        Number(new RegExp(`^rave_barrier_wait_seconds_${suffix} (\\S+)$`, 'm').exec(body)?.[1]);
      return { count: read('count'), sum: read('sum') };
    },
  };
}

const create: ClientMessage = {
  type: 'create-room',
  roomName: 'Kitchen',
  displayName: 'Keyur',
  durationSeconds: 10,
};

/** Who was sent a message of this type. */
function heard(outcome: Outcome, type: ServerMessage['type']): string[] {
  return outcome.deliveries.filter((d) => d.msg.type === type).map((d) => d.to);
}

/** A creator and one joiner. */
function pair(h: RoomHub) {
  const created = h.handle(undefined, create);
  const hostId = created.identity!;
  const code = (created.reply[0] as Extract<ServerMessage, { type: 'room-created' }>).code;
  const joined = h.handle(undefined, { type: 'join-room', code, displayName: 'Sam' });
  return { hostId, guestId: joined.identity!, code, joined };
}

describe('RoomHub', () => {
  it('gives a creator an identity, then the roster', () => {
    const { hub: h } = hub();
    const outcome = h.handle(undefined, create);

    assert.ok(outcome.identity);
    assert.equal(outcome.reply[0]?.type, 'room-created');
    assert.deepEqual(heard(outcome, 'room-state'), [outcome.identity]);
  });

  it('tells the whole room about a join, the joiner included', () => {
    const { hub: h } = hub();
    const { hostId, guestId, joined } = pair(h);

    assert.equal(joined.reply[0]?.type, 'room-joined');
    assert.deepEqual(heard(joined, 'room-state').sort(), [hostId, guestId].sort());
  });

  it('refuses a second room on a connection that already has one', () => {
    const { hub: h } = hub();
    const { hostId } = pair(h);
    const outcome = h.handle(hostId, create);

    assert.equal(outcome.identity, undefined);
    assert.equal(outcome.reply[0]?.type, 'error');
    assert.deepEqual(outcome.deliveries, []);
  });

  it('addresses a relayed signal to its target alone, stamped with the sender', () => {
    const { hub: h } = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.handle(hostId, { type: 'signal', to: guestId, data: { sdp: 'x' } });

    assert.deepEqual(outcome.deliveries, [
      { to: guestId, msg: { type: 'signal', from: hostId, data: { sdp: 'x' } } },
    ]);
  });

  it('drops the excluded on a forced start and tells only the survivors the roster', () => {
    const { hub: h } = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.handle(hostId, { type: 'start-playback', force: true });

    assert.deepEqual(heard(outcome, 'room-closed'), [guestId]);
    assert.deepEqual(heard(outcome, 'room-state'), [hostId]);
    assert.deepEqual(outcome.dropped, [guestId]);
  });

  it('tells the survivors why the room ended when the creator leaves', () => {
    const { hub: h } = hub();
    const { hostId, guestId } = pair(h);
    const outcome = h.leave(hostId);

    assert.deepEqual(heard(outcome, 'room-closed'), [guestId]);
    const closed = outcome.deliveries[0]!.msg as Extract<ServerMessage, { type: 'room-closed' }>;
    assert.equal(closed.reason, 'creator-left');
  });

  it('says nothing when someone in no room leaves', () => {
    const { hub: h } = hub();
    assert.deepEqual(h.leave('nobody').deliveries, []);
  });
});

describe('the barrier, as a consequence of the roster', () => {
  it('times from the last arrival to the last ready', async () => {
    const h = hub();
    const { guestId } = pair(h.hub);
    h.advance(4_000);
    h.hub.handle(guestId, { type: 'ready' });

    assert.deepEqual(await h.barrier(), { count: 1, sum: 4 });
  });

  it('settles when the last unready peer leaves instead', async () => {
    const h = hub();
    const { guestId, code } = pair(h.hub);
    const other = h.hub.handle(undefined, { type: 'join-room', code, displayName: 'Ada' });
    h.hub.handle(guestId, { type: 'ready' });
    assert.equal((await h.barrier()).count, 0, 'not all ready yet');

    h.advance(2_000);
    h.hub.leave(other.identity!);

    assert.deepEqual(await h.barrier(), { count: 1, sum: 2 });
  });

  it('records nothing for a room that was force-started past the barrier', async () => {
    const h = hub();
    const { hostId, code } = pair(h.hub);
    h.hub.handle(hostId, { type: 'start-playback', force: true });

    // Locked with only the creator left: every later change is a no-op here.
    const late = h.hub.handle(undefined, { type: 'join-room', code, displayName: 'Late' });
    assert.equal(late.reply[0]?.type, 'error');
    assert.equal((await h.barrier()).count, 0);
  });
});
