import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIC_BLOCKED, MIC_MISSING, Voice, levelOf } from './voice.ts';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** A track that records what was done to it. */
function track() {
  return { enabled: true, stopped: false, stop() { this.stopped = true; } };
}
function micStream(t = track()) {
  return { stream: { getAudioTracks: () => [t], getTracks: () => [t] } as unknown as MediaStream, track: t };
}

function setup(getMic?: () => Promise<MediaStream>) {
  const local: (MediaStreamTrack | null)[] = [];
  let remote: ((peerId: string, stream: MediaStream | undefined) => void) | undefined;
  let tick: (() => void) | undefined;
  const loud = { by: 0 };
  const context = {
    createAnalyser: () => ({
      fftSize: 0,
      getByteTimeDomainData(frame: Uint8Array) {
        frame.fill(128 + loud.by);
      },
    }),
    createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
  } as unknown as AudioContext;
  const mesh = {
    setLocalAudio: (t: MediaStreamTrack | null) => void local.push(t),
    onRemoteAudio: (fn: typeof remote) => {
      remote = fn;
      return () => {};
    },
  };
  const voice = new Voice({
    mesh,
    context,
    selfPeerId: SELF,
    getMic,
    every: (_ms, fn) => {
      tick = fn;
      return () => {};
    },
  });
  return { voice, local, loud, hear: (id: string, s?: MediaStream) => remote!(id, s), tick: () => tick!() };
}

describe('levelOf', () => {
  it('reads silence as zero and a loud frame as loud', () => {
    assert.equal(levelOf(new Uint8Array(64).fill(128)), 0);
    assert.ok(levelOf(new Uint8Array(64).fill(255)) > 0.9);
    assert.equal(levelOf(new Uint8Array(0)), 0);
  });
});

describe('the microphone', () => {
  it('goes on the mesh when enabled, mutes without leaving it, and is let go on release', async () => {
    const mic = micStream();
    const { voice, local } = setup(async () => mic.stream);
    await voice.enable();
    assert.equal(voice.state().micOn, true);
    assert.deepEqual(local, [mic.track]);

    voice.setMuted(true);
    assert.equal(mic.track.enabled, false);
    assert.equal(voice.state().muted, true);
    assert.equal(local.length, 1, 'muting does not touch the mesh');

    voice.setMuted(false);
    assert.equal(mic.track.enabled, true);

    voice.release();
    assert.equal(mic.track.stopped, true, 'the browser indicator goes out');
    assert.equal(voice.state().micOn, false);
    assert.deepEqual(local, [mic.track, null]);
  });

  it('says why in words when it cannot be had', async () => {
    const denied = setup(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    await denied.voice.enable();
    assert.equal(denied.voice.state().error, MIC_BLOCKED);
    assert.equal(denied.voice.state().micOn, false);

    const missing = setup(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })));
    await missing.voice.enable();
    assert.equal(missing.voice.state().error, MIC_MISSING);
  });

  it('lets go of a microphone that arrives after the room is gone', async () => {
    const mic = micStream();
    const { voice, local } = setup(async () => mic.stream);
    const pending = voice.enable();
    voice.close();
    await pending;
    assert.equal(mic.track.stopped, true);
    assert.deepEqual(local, []);
  });
});

describe('other people', () => {
  it('keeps each voice while their connection lasts and drops it after', () => {
    const { voice, hear } = setup();
    const stream = {} as MediaStream;
    hear(OTHER, stream);
    assert.equal(voice.state().streams.get(OTHER), stream);
    hear(OTHER, undefined);
    assert.equal(voice.state().streams.has(OTHER), false);
  });

  it('marks someone as speaking only while their level is above noise', () => {
    const { voice, hear, tick, loud } = setup();
    hear(OTHER, {} as MediaStream);
    tick();
    assert.equal(voice.state().speaking.has(OTHER), false);
    loud.by = 60;
    tick();
    assert.equal(voice.state().speaking.has(OTHER), true);
    loud.by = 0;
    tick();
    assert.equal(voice.state().speaking.has(OTHER), false);
  });
});
