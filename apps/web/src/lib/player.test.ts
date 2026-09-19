import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asCue, broadcastCue, listenForCues, Player, type AudioSink } from './player.ts';

/**
 * A fake sink and a fake source. Neither is Web Audio, but the only things
 * the player asks of them are currentTime and start/stop with a `when`, and
 * the arithmetic over the top is the entire point of these tests.
 */
interface FakeSource {
  buffer: unknown;
  connected: boolean;
  onended: (() => void) | null;
  /** The real node's AudioParam, as far as the nudge is concerned. */
  playbackRate: { value: number };
  started?: { when: number; offset: number };
  stopped?: number;
  start(when: number, offset: number): void;
  stop(when?: number): void;
}

function sink(startTime = 0) {
  const sources: FakeSource[] = [];
  const self = {
    currentTime: startTime,
    sources,
    destination: {} as AudioDestinationNode,
    createBufferSource(): AudioBufferSourceNode {
      const source: FakeSource = {
        buffer: undefined,
        connected: false,
        onended: null,
        playbackRate: { value: 1 },
        start(when, offset) {
          source.started = { when, offset };
        },
        stop(when) {
          source.stopped = when ?? self.currentTime;
        },
      };
      // A real node has a connect(); the player only ever calls it.
      (source as unknown as { connect: (d: unknown) => void }).connect = () => {
        source.connected = true;
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    /** The last source handed out, which is the one a test usually means. */
    last(): FakeSource {
      const found = sources.at(-1);
      assert.ok(found, 'no source was created');
      return found;
    },
  };
  return self as AudioSink & typeof self;
}

/** A buffer of a known length. Only `duration` is ever read. */
const buffer = (durationSeconds: number) => ({ duration: durationSeconds }) as AudioBuffer;

/** A monotonic clock the test drives, standing in for performance.now(). */
function monotonic(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('asCue', () => {
  it('ignores a file chunk on the shared channel', () => {
    // #5 sends binary down this same wire. Playback must not claim it.
    assert.equal(asCue(new ArrayBuffer(8)), undefined);
  });

  it("ignores #5's header and #6's clock traffic", () => {
    assert.equal(asCue(JSON.stringify({ type: 'file-header', fileName: 'a.mp3', byteLength: 1 })), undefined);
    assert.equal(asCue(JSON.stringify({ type: 'clock-ping', id: 1, t0: 0 })), undefined);
    assert.equal(asCue(JSON.stringify({ type: 'clock-pong', id: 1, t0: 0, t1: 1, t2: 2 })), undefined);
  });

  it('ignores malformed JSON and cues missing their fields', () => {
    assert.equal(asCue('not json'), undefined);
    assert.equal(asCue(JSON.stringify({ type: 'play' })), undefined);
    assert.equal(asCue(JSON.stringify({ type: 'play', startAt: 1 })), undefined);
    assert.equal(asCue(JSON.stringify({ type: 'pause' })), undefined);
  });

  it('accepts a well-formed pair', () => {
    assert.deepEqual(asCue(JSON.stringify({ type: 'play', startAt: 10, fromSeconds: 0 })), {
      type: 'play',
      startAt: 10,
      fromSeconds: 0,
    });
    assert.deepEqual(asCue(JSON.stringify({ type: 'pause', pauseAt: 5 })), {
      type: 'pause',
      pauseAt: 5,
    });
  });
});

describe('scheduling a start', () => {
  it('schedules against the audio clock, converting the creator instant with the offset', () => {
    // Our monotonic reads 1000. The audio clock reads 4 — unrelated number,
    // which is the whole reason the conversion exists.
    const clock = monotonic(1000);
    const out = sink(4);
    const player = new Player({ sink: out, buffer: buffer(120), now: clock.now });

    // The creator's clock runs 250ms ahead of ours, and it cued a start
    // 500ms into its own future: 1750 on its clock is 1500 on ours, which
    // is 500ms from now, which is audio time 4.5.
    player.apply({ type: 'play', startAt: 1750, fromSeconds: 0 }, 250);

    assert.equal(out.last().started?.when, 4.5);
    assert.equal(out.last().started?.offset, 0);
    assert.equal(out.last().connected, true);
  });

  it('gives two peers with different offsets the same real instant', () => {
    // The point of the product: same cue, same wall-clock moment, even
    // though neither device agrees on what time it is.
    const cue = { type: 'play', startAt: 5_000, fromSeconds: 0 } as const;

    const a = sink(10);
    const playerA = new Player({ sink: a, buffer: buffer(60), now: monotonic(4_800).now });
    playerA.apply(cue, 0); // The creator itself: no offset.

    const b = sink(99);
    // B's clock reads 3600 when the creator's reads 4800: add 1200 to B's
    // clock to get the creator's, which is exactly what clock.ts measures.
    const playerB = new Player({ sink: b, buffer: buffer(60), now: monotonic(3_600).now });
    playerB.apply(cue, 1_200);

    // Both land 200ms out on their own audio clocks: the same moment.
    // Within a microsecond, because the two audio clocks read wildly
    // different numbers and float subtraction is not exact at that spread.
    assert.ok(Math.abs(a.last().started!.when - 10 - 0.2) < 1e-6);
    assert.ok(Math.abs(b.last().started!.when - 99 - 0.2) < 1e-6);
  });

  it('applies the user offset on top of the measured one', () => {
    // #9's slider: a Bluetooth device that is 150ms late starts 150ms early.
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 1_000, fromSeconds: 0 }, 0, -150);
    assert.equal(out.last().started?.when, 0.85);
  });

  it('starts a late cue mid-track rather than from the beginning', () => {
    // A peer whose cue arrived 2s late must join in sync, not alone at 0:00.
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(3_000).now });
    player.apply({ type: 'play', startAt: 1_000, fromSeconds: 0 }, 0);

    assert.equal(out.last().started?.when, 0, 'immediately, not in the past');
    assert.equal(out.last().started?.offset, 2, 'two seconds in');
  });

  it('resumes from where the cue says, not from zero', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 500, fromSeconds: 30 }, 0);
    assert.equal(out.last().started?.offset, 30);
    assert.equal(out.last().started?.when, 0.5);
  });

  it('starts nothing when the cue is so late the track would be over', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(10), now: monotonic(30_000).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    assert.equal(out.sources.length, 0);
    assert.equal(player.state().playing, false);
    assert.equal(player.position(), 10);
  });

  it('replaces the previous source when a second play cue arrives', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 100, fromSeconds: 0 }, 0);
    const first = out.last();
    player.apply({ type: 'play', startAt: 200, fromSeconds: 10 }, 0);

    assert.equal(out.sources.length, 2);
    assert.notEqual(first.stopped, undefined, 'the first source was stopped');
    assert.equal(first.onended, null, 'and must not report that as the track ending');
    assert.equal(out.last().started?.offset, 10);
  });
});

describe('position', () => {
  it('derives from the audio clock, not a counter', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);

    out.currentTime = 12.5;
    assert.equal(player.position(), 12.5);
  });

  it('reads as the start position while a scheduled start is still pending', () => {
    // Between the cue and the instant, the honest answer is "not yet", not
    // a negative number counting down.
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 500, fromSeconds: 30 }, 0);
    assert.equal(player.position(), 30);
  });

  it('never runs past the end of the track', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(10), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    out.currentTime = 999;
    assert.equal(player.position(), 10);
  });

  it('settles at the end when the source reports it finished', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(10), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    out.last().onended?.();

    assert.equal(player.state().playing, false);
    assert.equal(player.position(), 10);
  });
});

describe('drift', () => {
  /**
   * A player mid-track, with the monotonic clock and the audio clock both
   * at a known place. Drift is what the test then introduces between them.
   */
  function playing({ offsetMs = 0, userOffsetMs = 0 } = {}) {
    const out = sink(0);
    const clock = monotonic(1000);
    const player = new Player({ sink: out, buffer: buffer(600), now: clock.now });
    // Cued to start now, from the top.
    player.apply({ type: 'play', startAt: 1000 + offsetMs, fromSeconds: 0 }, offsetMs, userOffsetMs);
    return { out, clock, player };
  }

  /** Move both clocks forward together — the no-drift case. */
  function elapse(ctx: ReturnType<typeof playing>, seconds: number) {
    ctx.clock.advance(seconds * 1000);
    ctx.out.currentTime += seconds;
  }

  it('reads zero while the two clocks agree', () => {
    const ctx = playing();
    elapse(ctx, 30);
    assert.equal(ctx.player.drift(), 0);
  });

  it('reads positive when the audio clock has run ahead', () => {
    const ctx = playing();
    elapse(ctx, 30);
    // The sound card ran 20ms fast over those 30s.
    ctx.out.currentTime += 0.02;
    assert.ok(Math.abs(ctx.player.drift() - 20) < 0.001, `got ${ctx.player.drift()}`);
  });

  it('reads negative when the audio clock has fallen behind', () => {
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime -= 0.02;
    assert.ok(Math.abs(ctx.player.drift() + 20) < 0.001, `got ${ctx.player.drift()}`);
  });

  it('measures against the corrected instant, not the creator\'s raw one', () => {
    // A peer 250ms off the creator is not 250ms adrift. Ignoring the offset
    // here would have every peer "correcting" its own clock difference away.
    const ctx = playing({ offsetMs: 250 });
    elapse(ctx, 30);
    assert.equal(ctx.player.drift(), 0);
  });

  it('measures against the user offset too', () => {
    // A Bluetooth listener deliberately 200ms late is where they asked to be.
    const ctx = playing({ userOffsetMs: 200 });
    elapse(ctx, 30);
    assert.equal(ctx.player.drift(), 0);
  });

  it('reads zero when nothing is playing', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    assert.equal(player.drift(), 0, 'a stopped track cannot be adrift');
  });

  it('nudges playbackRate for drift small enough to hear through', () => {
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime += 0.02; // 20ms ahead
    ctx.player.correct();

    const rate = ctx.out.last().playbackRate.value;
    assert.ok(rate < 1, `running ahead should slow down, got ${rate}`);
    assert.ok(rate > 0.99, `and inaudibly, got ${rate}`);
    assert.equal(ctx.out.sources.length, 1, 'a nudge does not restart the source');
  });

  it('nudges the other way when behind', () => {
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime -= 0.02;
    ctx.player.correct();

    const rate = ctx.out.last().playbackRate.value;
    assert.ok(rate > 1, `running behind should speed up, got ${rate}`);
    assert.ok(rate < 1.01, `and inaudibly, got ${rate}`);
  });

  it('leaves the rate alone when the drift is below the floor', () => {
    // Correcting a 3ms drift is chasing measurement noise, and every nudge
    // is a pitch change nobody asked for.
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime += 0.003;
    ctx.player.correct();
    assert.equal(ctx.out.last().playbackRate.value, 1);
  });

  it('restores the rate once the drift is corrected away', () => {
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime += 0.02;
    ctx.player.correct();
    assert.notEqual(ctx.out.last().playbackRate.value, 1);

    // The nudge did its job: over the next 10s it pulled the 20ms back.
    ctx.clock.advance(10_000);
    ctx.out.currentTime += 10 - 0.02;
    ctx.player.correct();
    assert.equal(ctx.out.last().playbackRate.value, 1, 'a corrected track plays at its own speed');
  });

  it('reseeks rather than nudges when the drift is too big to nudge away', () => {
    // 900ms is most of a second: nudging it out would take minutes and sound
    // wrong the whole time. Jumping is the lesser evil.
    const ctx = playing();
    elapse(ctx, 30);
    ctx.out.currentTime += 0.9;
    ctx.player.correct();

    assert.equal(ctx.out.sources.length, 2, 'a reseek is a new source');
    const started = ctx.out.last().started;
    assert.ok(started, 'the new source was started');
    // Back to where the shared clock says we should be: 30s in.
    assert.ok(Math.abs(started.offset - 30) < 0.01, `got ${started.offset}`);
    assert.equal(ctx.out.last().playbackRate.value, 1, 'and at normal speed');
  });

  it('does nothing when there is nothing playing', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    assert.doesNotThrow(() => player.correct());
    assert.equal(out.sources.length, 0);
  });

  it('reads zero on a cue that arrived late', () => {
    // A late joiner starts mid-track, so the position it starts at is not
    // the position the cue names. The two have to cancel: if the stored cue
    // were the adjusted instant rather than the original, every late peer
    // would come up already drifting by however late it was.
    const out = sink(0);
    const clock = monotonic(1000);
    const player = new Player({ sink: out, buffer: buffer(600), now: clock.now });

    player.apply({ type: 'play', startAt: 900, fromSeconds: 0 }, 0);

    assert.ok(Math.abs(player.position() - 0.1) < 1e-9, `got ${player.position()}`);
    assert.ok(Math.abs(player.drift()) < 1e-6, `got ${player.drift()}ms`);
  });
});

describe('the user offset', () => {
  it('reseeks the running track so the change is audible while dragging', () => {
    // Calibrating by ear is the only mechanism there is: a slider whose
    // effect you cannot hear until the next track is not a calibration.
    const out = sink(0);
    const clock = monotonic(1000);
    const player = new Player({ sink: out, buffer: buffer(600), now: clock.now });
    player.apply({ type: 'play', startAt: 1000, fromSeconds: 0 }, 0, 0);
    clock.advance(30_000);
    out.currentTime += 30;

    player.setUserOffset(-200);

    assert.equal(out.sources.length, 2, 'the change is heard now, not next cue');
    const started = out.last().started;
    assert.ok(started);
    // Asking to hear it 200ms earlier means playing 200ms further in.
    assert.ok(Math.abs(started.offset - 30.2) < 0.01, `got ${started.offset}`);
  });

  it('holds the value for a track that has not started yet', () => {
    const out = sink(0);
    const clock = monotonic(1000);
    const player = new Player({ sink: out, buffer: buffer(600), now: clock.now });

    player.setUserOffset(-200);
    assert.equal(out.sources.length, 0, 'nothing to reseek');

    // And the next cue honours it without being told again.
    player.apply({ type: 'play', startAt: 1500, fromSeconds: 0 }, 0);
    assert.equal(out.last().started?.when, 0.3, '500ms out, less the 200ms nudge');
  });

  it('is a no-op when the value has not actually changed', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(600), now: monotonic(1000).now });
    player.apply({ type: 'play', startAt: 1000, fromSeconds: 0 }, 0, -200);
    player.setUserOffset(-200);
    assert.equal(out.sources.length, 1, 'no pointless reseek');
  });
});

describe('scheduling a pause', () => {
  it('stops at the cued instant, not on arrival', () => {
    // Immediate-on-arrival would stop each device at a different sample,
    // and resume would then start them from positions that disagree.
    const clock = monotonic(1_000);
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: clock.now });
    player.apply({ type: 'play', startAt: 1_000, fromSeconds: 0 }, 0);

    clock.advance(2_000);
    out.currentTime = 2;
    player.apply({ type: 'pause', pauseAt: 3_500 }, 0);

    assert.equal(out.last().stopped, 2.5, 'half a second from now on the audio clock');
    assert.equal(player.position(), 2.5, 'where it will be when it stops');
    assert.equal(player.state().playing, false);
  });

  it('corrects the pause instant with the clock offset too', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    player.apply({ type: 'pause', pauseAt: 1_300 }, 300);
    assert.equal(out.last().stopped, 1);
  });

  it('resumes from where the pause landed', () => {
    const clock = monotonic(0);
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: clock.now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    clock.advance(5_000);
    out.currentTime = 5;
    player.apply({ type: 'pause', pauseAt: 5_000 }, 0);
    assert.equal(player.position(), 5);

    // The creator would send fromSeconds from its own player's position.
    player.apply({ type: 'play', startAt: 5_500, fromSeconds: player.position() }, 0);
    assert.equal(out.last().started?.offset, 5);
  });

  it('ignores a pause when nothing is playing', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    assert.doesNotThrow(() => player.apply({ type: 'pause', pauseAt: 100 }, 0));
    assert.equal(out.sources.length, 0);
  });
});

describe('lifecycle', () => {
  it('tells subscribers when playback state changes', () => {
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    let calls = 0;
    const unsubscribe = player.subscribe(() => calls++);

    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    assert.equal(calls, 1);
    player.apply({ type: 'pause', pauseAt: 0 }, 0);
    assert.equal(calls, 2);

    unsubscribe();
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    assert.equal(calls, 2, 'an unsubscribed listener hears nothing');
  });

  it('stops the audio and ignores later cues once closed', () => {
    // The room ended. A cue still in flight must not restart the track.
    const out = sink(0);
    const player = new Player({ sink: out, buffer: buffer(60), now: monotonic(0).now });
    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    const source = out.last();

    player.close();
    assert.notEqual(source.stopped, undefined);

    player.apply({ type: 'play', startAt: 0, fromSeconds: 0 }, 0);
    assert.equal(out.sources.length, 1);
  });
});

/** A channel that records what went down it and can be delivered into. */
function cueChannel(readyState = 'open') {
  const listeners = new Set<(e: MessageEvent) => void>();
  const self = {
    readyState,
    sent: [] as string[],
    send(data: string) {
      if (self.readyState !== 'open') throw new Error('closed');
      self.sent.push(data);
    },
    deliver(data: unknown) {
      for (const l of [...listeners]) l({ data } as MessageEvent);
    },
    addEventListener(_t: string, fn: (e: MessageEvent) => void) {
      listeners.add(fn);
    },
    removeEventListener(_t: string, fn: (e: MessageEvent) => void) {
      listeners.delete(fn);
    },
    listenerCount: () => listeners.size,
  };
  return self;
}

describe('broadcastCue', () => {
  it('sends the cue to every open channel', () => {
    const a = cueChannel();
    const b = cueChannel();
    const channels = new Map([
      ['a', a],
      ['b', b],
    ]);
    const sent = broadcastCue(
      { channel: (id) => channels.get(id) as unknown as RTCDataChannel },
      ['a', 'b'],
      { type: 'play', startAt: 100, fromSeconds: 0 },
    );

    assert.equal(sent, 2);
    assert.deepEqual(JSON.parse(a.sent[0]!), { type: 'play', startAt: 100, fromSeconds: 0 });
    assert.deepEqual(JSON.parse(b.sent[0]!), { type: 'play', startAt: 100, fromSeconds: 0 });
  });

  it('skips a peer with no channel or a closed one, and still reaches the rest', () => {
    // One peer leaving must not stop the room starting.
    const open = cueChannel();
    const shut = cueChannel('closed');
    const channels = new Map([
      ['open', open],
      ['shut', shut],
    ]);
    const sent = broadcastCue(
      { channel: (id) => channels.get(id) as unknown as RTCDataChannel },
      ['open', 'shut', 'gone'],
      { type: 'pause', pauseAt: 1 },
    );

    assert.equal(sent, 1);
    assert.equal(open.sent.length, 1);
  });
});

describe('listenForCues', () => {
  /** A mesh whose creator channel shows up late, as a real one does. */
  function transport() {
    const listeners = new Set<() => void>();
    let channel: ReturnType<typeof cueChannel> | undefined;
    return {
      open() {
        channel = cueChannel();
        for (const l of [...listeners]) l();
        return channel;
      },
      current: () => channel,
      channel: () => channel as unknown as RTCDataChannel | undefined,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  it('attaches once the creator channel opens and reports cues', () => {
    const mesh = transport();
    const heard: unknown[] = [];
    const stop = listenForCues(mesh, 'creator', (cue) => heard.push(cue));

    const channel = mesh.open();
    channel.deliver(JSON.stringify({ type: 'play', startAt: 7, fromSeconds: 0 }));

    assert.deepEqual(heard, [{ type: 'play', startAt: 7, fromSeconds: 0 }]);
    stop();
  });

  it('ignores traffic that is not a cue', () => {
    const mesh = transport();
    const heard: unknown[] = [];
    const stop = listenForCues(mesh, 'creator', (cue) => heard.push(cue));
    const channel = mesh.open();

    channel.deliver(new ArrayBuffer(8));
    channel.deliver(JSON.stringify({ type: 'clock-ping', id: 1, t0: 0 }));
    assert.equal(heard.length, 0);
    stop();
  });

  it('attaches once however many times the mesh notifies', () => {
    // The mesh notifies on every connection state change; a listener per
    // notify would fire one cue N times.
    const mesh = transport();
    const heard: unknown[] = [];
    const stop = listenForCues(mesh, 'creator', (cue) => heard.push(cue));
    const channel = mesh.open();
    channel.deliver(JSON.stringify({ type: 'pause', pauseAt: 1 }));

    assert.equal(channel.listenerCount(), 1);
    assert.equal(heard.length, 1);
    stop();
    assert.equal(channel.listenerCount(), 0, 'and detaches on stop');
  });
});
