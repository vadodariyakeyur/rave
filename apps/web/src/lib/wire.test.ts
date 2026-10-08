import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeerMessage } from './wire.ts';

/**
 * Three kinds of traffic share one channel, so "not ours" is the ordinary
 * case: the parser has to wave through what it knows and ignore the rest
 * without ever throwing.
 */
describe('parsePeerMessage', () => {
  it('ignores a file chunk on the shared channel', () => {
    assert.equal(parsePeerMessage(new ArrayBuffer(8)), undefined);
  });

  it("ignores the file transfer's header", () => {
    const header = JSON.stringify({ type: 'file-header', fileName: 'a.mp3', byteLength: 10 });
    assert.equal(parsePeerMessage(header), undefined);
  });

  it('ignores malformed JSON and messages missing their fields', () => {
    assert.equal(parsePeerMessage('not json'), undefined);
    assert.equal(parsePeerMessage('null'), undefined);
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'clock-ping' })), undefined);
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'clock-pong', id: 1 })), undefined);
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'play' })), undefined);
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'play', startAt: 1 })), undefined);
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'pause' })), undefined);
  });

  it('is not fooled by a type that names an object method', () => {
    assert.equal(parsePeerMessage(JSON.stringify({ type: 'toString' })), undefined);
  });

  it('accepts each well-formed message', () => {
    const messages = [
      { type: 'play', startAt: 10, fromSeconds: 0 },
      { type: 'pause', pauseAt: 5 },
      { type: 'clock-ping', id: 1, t0: 0 },
      { type: 'clock-pong', id: 1, t0: 0, t1: 1, t2: 2 },
    ];
    for (const msg of messages) assert.deepEqual(parsePeerMessage(JSON.stringify(msg)), msg);
  });
});
