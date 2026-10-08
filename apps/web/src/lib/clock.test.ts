import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClockProbe, estimate, sampleOf, serveClock, type Sample } from './clock.ts';
import { link, linked, step, virtualClock, type FakeChannel } from './testing.ts';
import type { ClockPong } from './wire.ts';

describe('sampleOf', () => {
  it('recovers a known offset from a symmetric link', () => {
    // Creator's clock runs 1000ms ahead of ours; each leg takes 10ms.
    // t0=0 -> creator sees it at 1010 (its clock), replies at 1012,
    // which reaches us at 22 (ours).
    const pong: ClockPong = { type: 'clock-pong', id: 1, t0: 0, t1: 1010, t2: 1012 };
    const sample = sampleOf(pong, 22);
    assert.equal(sample.rtt, 20, 'rtt excludes the time the creator held it');
    assert.equal(sample.offset, 1000);
  });

  it('is wrong by exactly half the asymmetry, which is the error floor', () => {
    // Same 1000ms offset, but 30ms out and 10ms back. NTP cannot see this:
    // it assumes symmetry, so the estimate lands 10ms high. Pinned because
    // it is the real accuracy limit, not a bug to fix later.
    const pong: ClockPong = { type: 'clock-pong', id: 1, t0: 0, t1: 1030, t2: 1032 };
    const sample = sampleOf(pong, 42);
    assert.equal(sample.rtt, 40);
    assert.equal(sample.offset, 1010);
  });

  it('handles a creator whose clock is behind ours', () => {
    const pong: ClockPong = { type: 'clock-pong', id: 1, t0: 5000, t1: 10, t2: 12 };
    const sample = sampleOf(pong, 5022);
    assert.equal(sample.offset, -5000);
  });
});

describe('estimate', () => {
  it('keeps the fastest quarter and takes their median', () => {
    // Eight samples: the four fastest all say 100, the slow ones say wild
    // things. A mean over everything would land nowhere near 100.
    const samples: Sample[] = [
      { rtt: 10, offset: 100 },
      { rtt: 12, offset: 102 },
      { rtt: 14, offset: 98 },
      { rtt: 16, offset: 101 },
      { rtt: 200, offset: 400 },
      { rtt: 220, offset: -300 },
      { rtt: 240, offset: 900 },
      { rtt: 260, offset: 50 },
    ];
    const result = estimate(samples);
    assert.equal(result.sampleCount, 8);
    assert.equal(result.rttsMs.length, 2, 'a quarter of eight');
    assert.deepEqual([...result.rttsMs], [10, 12]);
    assert.equal(result.offsetMs, 101);
  });

  it('ignores an outlier that would wreck a mean', () => {
    // One sample queued behind something and reports an offset 50x too big.
    // The median must not care.
    const samples: Sample[] = [
      { rtt: 10, offset: 20 },
      { rtt: 10, offset: 21 },
      { rtt: 10, offset: 19 },
      { rtt: 11, offset: 1000 },
    ];
    const result = estimate(samples);
    assert.ok(
      result.offsetMs !== undefined && Math.abs(result.offsetMs - 20) < 2,
      `expected ~20, got ${result.offsetMs}`,
    );
  });

  it('keeps at least one sample rather than filtering a short round to nothing', () => {
    const result = estimate([{ rtt: 5, offset: 7 }]);
    assert.equal(result.offsetMs, 7);
    assert.equal(result.rttsMs.length, 1);
  });

  it('reports no offset for a round that landed nothing', () => {
    assert.equal(estimate([]).offsetMs, undefined);
  });
});

describe('serveClock', () => {
  it('echoes the id and t0, and reports its own hold time', () => {
    const c = link();
    let clock = 500;
    const stop = serveClock(c.link, () => (clock += 2));
    c.channel.deliver(JSON.stringify({ type: 'clock-ping', id: 7, t0: 123 }));

    assert.equal(c.channel.sent.length, 1);
    const pong = c.channel.messages()[0] as unknown as ClockPong;
    assert.equal(pong.type, 'clock-pong');
    assert.equal(pong.id, 7);
    assert.equal(pong.t0, 123, 'the peer must be able to match its own probe');
    assert.ok(pong.t2 > pong.t1, 'holding the ping took non-zero time');
    stop();
  });

  it('stays quiet for anything that is not a ping', () => {
    const c = link();
    serveClock(c.link, () => 0);
    c.channel.deliver(JSON.stringify({ type: 'file-header', fileName: 'a', byteLength: 1 }));
    c.channel.deliver('garbage');
    assert.equal(c.channel.sent.length, 0);
  });

  it('stops answering once stopped', () => {
    const c = link();
    const stop = serveClock(c.link, () => 0);
    stop();
    c.channel.deliver(JSON.stringify({ type: 'clock-ping', id: 1, t0: 0 }));
    assert.equal(c.channel.sent.length, 0);
  });

  it('does not throw when the channel died mid-reply', () => {
    const c = link();
    serveClock(c.link, () => 0);
    c.channel.readyState = 'closed';
    assert.doesNotThrow(() =>
      c.channel.deliver(JSON.stringify({ type: 'clock-ping', id: 1, t0: 0 })),
    );
  });
});

describe('ClockProbe', () => {
  /**
   * Run the probe against a served creator on a link with a known offset and
   * one-way delay, stepping the virtual clock until a round completes.
   */
  function run({ offset, oneWay }: { offset: number; oneWay: number }) {
    const { a: peer, b: host } = linked();

    const clock = virtualClock();
    // The creator reads the same tick counter, shifted. Rediscovering that
    // shift is the entire job.
    const hostNow = () => clock.now() + offset;

    // Charge the one-way delay on each hop by advancing before delivery.
    const hop = (target: FakeChannel) => {
      const original = target.deliver.bind(target);
      target.deliver = (data: unknown) => {
        clock.advance(oneWay);
        original(data);
      };
    };
    hop(peer.channel);
    hop(host.channel);

    return { peer, host, clock, hostNow };
  }

  it('measures the offset over a link with a known delay', async () => {
    const { peer, host, clock, hostNow } = run({ offset: 250, oneWay: 5 });
    const stopServing = serveClock(host.link, hostNow);
    const probe = new ClockProbe(peer.link, clock);
    probe.start();
    // One round: 20 probes, 50ms apart.
    await step(clock, 1_500);

    const est = probe.estimate();
    assert.ok(est.offsetMs !== undefined, 'a round should have landed');
    assert.ok(Math.abs(est.offsetMs - 250) < 2, `expected ~250ms, got ${est.offsetMs}`);
    assert.ok(est.sampleCount > 0);
    probe.close();
    stopServing();
  });

  it('ignores a pong for a probe that already timed out', async () => {
    // Its round has been scored. Folding it in now would mix two rounds.
    const { peer, host, clock, hostNow } = run({ offset: 100, oneWay: 1 });
    const stopServing = serveClock(host.link, hostNow);
    const probe = new ClockProbe(peer.link, clock);
    probe.start();
    await step(clock, 1_500);

    const before = probe.estimate();
    // id 9999 was never issued.
    peer.channel.deliver(JSON.stringify({ type: 'clock-pong', id: 9999, t0: 0, t1: 5, t2: 6 }));
    assert.deepEqual(probe.estimate(), before);
    probe.close();
    stopServing();
  });

  it('holds its last offset through a lost round, but reports it as stale', async () => {
    // A stale offset beats no offset. Zero samples is how the overlay knows
    // to say so, instead of showing the old number as if it were fresh.
    const { peer, host, clock, hostNow } = run({ offset: 100, oneWay: 1 });
    const stopServing = serveClock(host.link, hostNow);
    const probe = new ClockProbe(peer.link, clock);
    probe.start();
    await step(clock, 1_500);

    const good = probe.estimate();
    assert.ok(good.offsetMs !== undefined);

    // The creator goes dark. Every probe from here times out.
    stopServing();
    peer.channel.readyState = 'closed';
    await step(clock, 10_000);

    assert.equal(probe.estimate().offsetMs, good.offsetMs, 'the last good offset stands');
    assert.equal(probe.estimate().sampleCount, 0, 'but it must not read as freshly measured');
    probe.close();
  });

  it('reports nothing before the first round lands', () => {
    const probe = new ClockProbe(link().link, virtualClock());
    assert.equal(probe.estimate().offsetMs, undefined);
    probe.close();
  });

  it('waits for the link to open instead of spending a round on a dead one', async () => {
    // Probing a channel that is not open yet burns the first round and then
    // sleeps out the interval — and the first offset is the one a start cue
    // is waiting for.
    const peer = link('connecting');
    const host = link();
    peer.channel.peer = host.channel;
    host.channel.peer = peer.channel;
    const clock = virtualClock();
    serveClock(host.link, () => clock.now() + 40);
    const probe = new ClockProbe(peer.link, clock);
    probe.start();
    await step(clock, 3_000);
    assert.equal(peer.channel.sent.length, 0, 'nothing sent into a channel that is not open');

    peer.channel.open();
    await step(clock, 1_500);
    assert.equal(probe.estimate().offsetMs, 40, 'and a full round straight after it opens');
    probe.close();
  });

  it('stops probing once closed', async () => {
    const { peer, host, clock, hostNow } = run({ offset: 0, oneWay: 1 });
    serveClock(host.link, hostNow);
    const probe = new ClockProbe(peer.link, clock);
    probe.start();
    await step(clock, 300);
    probe.close();

    const sentSoFar = peer.channel.sent.length;
    await step(clock, 5_000);
    assert.equal(peer.channel.sent.length, sentSoFar, 'a closed probe must not keep pinging');
  });
});
