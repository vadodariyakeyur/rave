import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BarrierTimer, Metrics } from './metrics.ts';

/** A controllable monotonic clock, in milliseconds. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Collects what the timer would have put in the histogram. */
function recorder() {
  const seen: number[] = [];
  return { seen, observe: (s: number) => seen.push(s) };
}

describe('BarrierTimer', () => {
  it('records creation to the moment the last peer is ready', () => {
    const rec = recorder();
    const c = clock(1000);
    const timer = new BarrierTimer(rec.observe, c.now);

    timer.open('ABC123');
    c.advance(4500);
    timer.settle('ABC123', [{ ready: true }, { ready: false }]);
    assert.deepEqual(rec.seen, [], 'settled while a peer was still downloading');

    c.advance(3000);
    timer.settle('ABC123', [{ ready: true }, { ready: true }]);
    assert.deepEqual(rec.seen, [7.5]);
  });

  it('ignores a room that is only its creator', () => {
    // The creator is born ready, so a lone room is trivially all-ready. A
    // zero here for every room ever made would drag the reported wait down
    // to nothing and hide the barriers that actually took time.
    const rec = recorder();
    const timer = new BarrierTimer(rec.observe, clock().now);

    timer.open('ABC123');
    timer.settle('ABC123', [{ ready: true }]);
    assert.deepEqual(rec.seen, []);
  });

  it('records a barrier once, not again when a peer leaves', () => {
    const rec = recorder();
    const c = clock();
    const timer = new BarrierTimer(rec.observe, c.now);

    timer.open('ABC123');
    c.advance(2000);
    timer.settle('ABC123', [{ ready: true }, { ready: true }, { ready: true }]);
    c.advance(9000);
    timer.settle('ABC123', [{ ready: true }, { ready: true }]);

    assert.deepEqual(rec.seen, [2]);
  });

  it('forgets a room that closed before it settled', () => {
    const rec = recorder();
    const timer = new BarrierTimer(rec.observe, clock().now);

    timer.open('ABC123');
    timer.close('ABC123');
    timer.settle('ABC123', [{ ready: true }, { ready: true }]);
    assert.deepEqual(rec.seen, []);
  });

  it('ignores a room it never saw open', () => {
    const rec = recorder();
    const timer = new BarrierTimer(rec.observe, clock().now);
    timer.settle('NEVER1', [{ ready: true }, { ready: true }]);
    assert.deepEqual(rec.seen, []);
  });
});

describe('Metrics', () => {
  it('renders both force-start label values before any start happens', async () => {
    // Without the zero-init, rate() on the forced series has nothing to
    // divide and the dashboard panel comes up blank rather than at zero.
    const { body, contentType } = await new Metrics().render();
    assert.match(contentType, /text\/plain/);
    assert.match(body, /rave_starts_total\{forced="true"\} 0/);
    assert.match(body, /rave_starts_total\{forced="false"\} 0/);
  });

  it('reads the live gauges at scrape time, not when they were set', async () => {
    // The whole point of the collect callback: a scrape has to report the
    // roster as it is now, not as it was when the gauge was constructed.
    const live = { size: 0, peerCount: 0 };
    const metrics = new Metrics(live);
    metrics.barrierWaitSeconds.observe(4.5);

    live.size = 3;
    live.peerCount = 11;

    const { body } = await metrics.render();
    assert.match(body, /^rave_rooms_live 3$/m);
    assert.match(body, /^rave_peers_live 11$/m);
    assert.match(body, /rave_barrier_wait_seconds_sum 4\.5/);
  });
});

describe('BarrierTimer default clock', () => {
  it('works without an injected clock', () => {
    // Regression: performance.now passed bare loses its receiver and throws
    // when called as a method. Every other test injects a fake clock, so
    // this is the only one that exercises the default.
    const rec = recorder();
    const timer = new BarrierTimer(rec.observe);
    timer.open('ABC123');
    timer.settle('ABC123', [{ ready: true }, { ready: true }]);
    assert.equal(rec.seen.length, 1);
    assert.ok(rec.seen[0]! >= 0, `negative wait ${rec.seen[0]}`);
  });
});
