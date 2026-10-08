import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelLink } from './link.ts';
import { bytes, channel, link, linked } from './testing.ts';

/**
 * What a link takes off everyone's hands: a channel that is not there yet,
 * one that has not opened, and three kinds of traffic on one wire.
 */

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

const file = { bytes: bytes(40_000), fileName: 'track.mp3' };

describe('ChannelLink', () => {
  it('hears a message subscribed to before the channel existed', () => {
    const made = new ChannelLink();
    const heard: unknown[] = [];
    made.on('play', (cue) => heard.push(cue));

    const wire = channel();
    made.attach(wire);
    wire.deliver(JSON.stringify({ type: 'play', startAt: 7, fromSeconds: 0 }));

    assert.deepEqual(heard, [{ type: 'play', startAt: 7, fromSeconds: 0 }]);
  });

  it('gives each kind of message only to those who asked for it', () => {
    const { link: made, channel: wire } = link();
    const cues: unknown[] = [];
    const pings: unknown[] = [];
    made.on('pause', (m) => cues.push(m));
    made.on('clock-ping', (m) => pings.push(m));

    wire.deliver(JSON.stringify({ type: 'clock-ping', id: 1, t0: 0 }));
    wire.deliver(new ArrayBuffer(8));
    wire.deliver('garbage');

    assert.equal(cues.length, 0);
    assert.equal(pings.length, 1);
  });

  it('stops delivering once unsubscribed', () => {
    const { link: made, channel: wire } = link();
    const heard: unknown[] = [];
    const stop = made.on('pause', (m) => heard.push(m));
    stop();
    wire.deliver(JSON.stringify({ type: 'pause', pauseAt: 1 }));
    assert.equal(heard.length, 0);
  });

  it('says a message did not go, rather than throwing or queueing it', () => {
    const cue = { type: 'pause', pauseAt: 1 } as const;
    assert.equal(new ChannelLink().send(cue), false, 'no channel at all');
    assert.equal(link('connecting').link.send(cue), false, 'not open yet');
    assert.equal(link('closed').link.send(cue), false, 'closed');

    const open = link();
    assert.equal(open.link.send(cue), true);
    assert.deepEqual(open.channel.messages(), [cue]);
  });

  it('follows a replacement channel, and lets go of the old one', () => {
    const made = new ChannelLink();
    const heard: unknown[] = [];
    made.on('pause', (m) => heard.push(m));
    const old = channel();
    const fresh = channel();
    made.attach(old);
    made.attach(fresh);

    old.deliver(JSON.stringify({ type: 'pause', pauseAt: 1 }));
    fresh.deliver(JSON.stringify({ type: 'pause', pauseAt: 2 }));

    assert.deepEqual(heard, [{ type: 'pause', pauseAt: 2 }]);
  });

  it('opens when the channel does', async () => {
    const { link: made, channel: wire } = link('connecting');
    let opened = false;
    void made.opened().then(() => (opened = true));
    await settle();
    assert.equal(opened, false);

    wire.open();
    await settle();
    assert.equal(opened, true);
  });

  it('refuses to wait on a channel that closed, or a peer who left', async () => {
    const dying = link('connecting');
    const waiting = dying.link.opened();
    dying.channel.close();
    await assert.rejects(waiting);

    const leaving = new ChannelLink();
    const never = leaving.opened();
    leaving.close();
    await assert.rejects(never);
    await assert.rejects(leaving.opened(), 'and stays closed');
  });

  it('carries a file alongside everything else on the wire', async () => {
    // The clock keeps probing while the file is in flight. Neither may
    // mistake the other's traffic for its own.
    const { a, b } = linked();
    const pings: unknown[] = [];
    b.link.on('clock-ping', (m) => pings.push(m));

    const receiving = b.link.receiveFile();
    await settle();
    const sending = a.link.sendFile(file);
    a.link.send({ type: 'clock-ping', id: 1, t0: 0 });
    await sending;
    const got = await receiving;

    assert.equal(got.fileName, 'track.mp3');
    assert.deepEqual(new Uint8Array(got.bytes), new Uint8Array(file.bytes));
    assert.equal(pings.length, 1);
  });

  it('holds a file until the peer can take it', async () => {
    const made = new ChannelLink();
    const sending = made.sendFile(file);
    const wire = channel('connecting');
    made.attach(wire);
    await settle();
    assert.equal(wire.sent.length, 0);

    wire.open();
    await sending;
    assert.ok(wire.sent.length > 1, 'a header and its chunks');
  });
});
