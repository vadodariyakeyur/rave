import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armAudio, decodeBytes, DECODE_ERROR } from './audio.ts';

/**
 * Fakes stand in for Web Audio, which does not exist in Node. What is under
 * test is the ordering and error contract, not the browser's decoder:
 * arming must happen on the gesture, and a bad file must throw a message a
 * human can act on rather than leaking a DOMException.
 */
function fakeContext(opts: { decode?: (b: ArrayBuffer) => Promise<unknown>; state?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      state: opts.state ?? 'suspended',
      sampleRate: 48000,
      currentTime: 0,
      resume: async () => { calls.push('resume'); },
      createBuffer: (_c: number, _l: number, _r: number) => ({ duration: 0 }),
      createBufferSource: () => ({
        buffer: null,
        connect: () => { calls.push('connect'); },
        start: () => { calls.push('start'); },
      }),
      destination: {},
      decodeAudioData: opts.decode ?? (async () => ({ duration: 12.5 })),
    },
  };
}

describe('armAudio', () => {
  it('resumes a suspended context and plays a silent buffer', async () => {
    const { ctx, calls } = fakeContext();
    await armAudio(ctx as never);
    // Resume alone is not enough on iOS; a real source must have run.
    assert.deepEqual(calls, ['resume', 'connect', 'start']);
  });

  it('still plays the silent buffer when already running', async () => {
    const { ctx, calls } = fakeContext({ state: 'running' });
    await armAudio(ctx as never);
    assert.deepEqual(calls, ['connect', 'start']);
  });
});

describe('decodeBytes', () => {
  it('leaves the caller their bytes, because the creator still has to send them', async () => {
    // decodeAudioData detaches what it is handed. Handing it a copy is the
    // whole reason the creator can transfer the file after decoding it.
    const bytes = new ArrayBuffer(8);
    const ctx = {
      decodeAudioData: async (b: ArrayBuffer) => {
        assert.notEqual(b, bytes, 'must not hand the caller\'s own buffer over');
        return { duration: 1 } as AudioBuffer;
      },
    };
    await decodeBytes(ctx as never, bytes);
    assert.equal(bytes.byteLength, 8, 'the caller\'s buffer was detached');
  });

  it('returns the decoded buffer and its duration', async () => {
    const { ctx } = fakeContext();
    const result = await decodeBytes(ctx as never, new ArrayBuffer(8));
    assert.equal(result.durationSeconds, 12.5);
    assert.ok(result.buffer);
  });

  it('throws a human-readable error rather than leaking a DOMException', async () => {
    const { ctx } = fakeContext({
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
    });
    await assert.rejects(
      () => decodeBytes(ctx as never, new ArrayBuffer(8)),
      (err: Error) => err.message === DECODE_ERROR,
    );
  });

  it('rejects a zero-length decode rather than issuing a room for silence', async () => {
    const { ctx } = fakeContext({ decode: async () => ({ duration: 0 }) });
    await assert.rejects(
      () => decodeBytes(ctx as never, new ArrayBuffer(8)),
      (err: Error) => err.message === DECODE_ERROR,
    );
  });
});
