import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armAudio, decodeFile, DECODE_ERROR } from './audio.ts';

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

describe('decodeFile', () => {
  it('returns the decoded buffer and its duration', async () => {
    const { ctx } = fakeContext();
    const file = new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' });
    const result = await decodeFile(ctx as never, file);
    assert.equal(result.durationSeconds, 12.5);
    assert.ok(result.buffer);
  });

  it('throws a human-readable error when the file cannot be decoded', async () => {
    const { ctx } = fakeContext({
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
    });
    const file = new File([new Uint8Array([9])], 'notaudio.txt', { type: 'text/plain' });
    await assert.rejects(() => decodeFile(ctx as never, file), (err: Error) => {
      assert.equal(err.message, DECODE_ERROR);
      return true;
    });
  });

  it('rejects a zero-length decode rather than issuing a room for silence', async () => {
    const { ctx } = fakeContext({ decode: async () => ({ duration: 0 }) });
    const file = new File([new Uint8Array([1])], 'empty.mp3', { type: 'audio/mpeg' });
    await assert.rejects(() => decodeFile(ctx as never, file), (err: Error) => {
      assert.equal(err.message, DECODE_ERROR);
      return true;
    });
  });
});
