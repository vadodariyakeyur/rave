import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Distributor, Receiver } from './distribute.ts';
import { send } from './transfer.ts';
import { bytes, channel, FakeMesh, type FakeChannel } from './testing.ts';

/**
 * The playlist, on its way from the creator to every member. The rules worth
 * pinning: every track reaches every member, in order, one at a time; a track
 * added later reaches people already here; a roster change never restarts a
 * file in flight; and one member failing never holds up another.
 */

/** Long enough for several multi-chunk sends to run to completion. */
const settle = async () => {
  for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 0));
};

const track = (trackId: string, length = 40_000) => ({
  trackId,
  bytes: bytes(length),
  fileName: `${trackId}.mp3`,
});

/** The track ids of the file headers a channel has carried, in order. */
const headers = (wire: FakeChannel) =>
  wire.messages().filter((m) => m.type === 'file-header').map((m) => m.trackId);

describe('Distributor', () => {
  it('sends every track to every member, in playlist order', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a');
    const b = mesh.connect('b');

    const d = new Distributor(mesh);
    d.setTracks([track('one'), track('two')]);
    d.sync(['a', 'b']);
    await settle();

    assert.deepEqual(headers(a), ['one', 'two']);
    assert.deepEqual(headers(b), ['one', 'two']);
    assert.deepEqual(d.transfers().get('a'), { progress: 1, state: 'sent' });
  });

  it('sends a track added later to members who are already here', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a');
    const d = new Distributor(mesh);
    d.setTracks([track('one')]);
    d.sync(['a']);
    await settle();

    d.setTracks([track('one'), track('two')]);
    assert.equal(d.transfers().get('a')?.state, 'downloading', 'there is more to send again');
    await settle();

    assert.deepEqual(headers(a), ['one', 'two'], 'and the first is not sent twice');
    assert.equal(d.transfers().get('a')?.state, 'sent');
  });

  it('sends the whole playlist to someone who joins late', async () => {
    const mesh = new FakeMesh();
    const d = new Distributor(mesh);
    d.setTracks([track('one'), track('two')]);
    d.sync([]);

    const late = mesh.connect('late');
    d.sync(['late']);
    await settle();

    assert.deepEqual(headers(late), ['one', 'two']);
  });

  it('waits for a channel that is not open yet, then sends once it is', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a', 'connecting');
    const d = new Distributor(mesh);
    d.setTracks([track('one')]);
    d.sync(['a']);
    await settle();
    assert.deepEqual(d.transfers().get('a'), { progress: 0, state: 'downloading' });

    a.open();
    await settle();
    assert.equal(d.transfers().get('a')?.state, 'sent');
  });

  it('never has two files on one channel at once, however often it is poked', async () => {
    // sync runs on every roster change and setTracks on every playlist edit.
    // A second file started mid-first would interleave into one buffer.
    const mesh = new FakeMesh();
    const a = mesh.connect('a');
    const d = new Distributor(mesh);
    const tracks = [track('one', 200_000), track('two', 200_000)];
    d.setTracks(tracks);
    d.sync(['a']);
    d.sync(['a']);
    d.setTracks(tracks);
    d.setTracks(tracks);
    await settle();

    assert.deepEqual(headers(a), ['one', 'two']);
  });

  it('does not send a track that was removed before its turn', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a', 'connecting');
    const d = new Distributor(mesh);
    d.setTracks([track('one'), track('two'), track('three')]);
    d.sync(['a']);
    d.setTracks([track('one'), track('three')]);

    a.open();
    await settle();
    assert.deepEqual(headers(a), ['one', 'three']);
  });

  it('counts progress across the whole playlist, by bytes', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a');
    const d = new Distributor(mesh);
    d.setTracks([track('small', 10_000)]);
    d.sync(['a']);
    await settle();

    // One of four equal parts is through; three more have just been added.
    d.setTracks([track('small', 10_000), track('big', 30_000)]);
    const { progress } = d.transfers().get('a')!;
    assert.ok(progress >= 0.25 && progress < 1, `got ${progress}`);
  });

  it('marks one member stalled without touching the other', async () => {
    // A failing member must not hold up anyone else's download.
    const mesh = new FakeMesh();
    mesh.connect('good');
    mesh.connect('bad', 'closed');

    const d = new Distributor(mesh);
    d.setTracks([track('one')]);
    d.sync(['good', 'bad']);
    await settle();

    assert.equal(d.transfers().get('good')?.state, 'sent');
    assert.equal(d.transfers().get('bad')?.state, 'stalled');
  });

  it('forgets a member who left', async () => {
    const mesh = new FakeMesh();
    mesh.connect('a');
    const d = new Distributor(mesh);
    d.setTracks([track('one')]);
    d.sync(['a']);
    await settle();

    d.sync([]);
    assert.equal(d.transfers().get('a'), undefined);
  });

  it('has nothing to show while the playlist is empty', () => {
    const mesh = new FakeMesh();
    mesh.connect('a');
    const d = new Distributor(mesh);
    d.sync(['a']);
    assert.equal(d.transfers().size, 0);
  });

  it('notifies subscribers as progress moves', async () => {
    const mesh = new FakeMesh();
    mesh.connect('a');
    const d = new Distributor(mesh);
    let notified = 0;
    d.subscribe(() => notified++);
    d.setTracks([track('one')]);
    d.sync(['a']);
    await settle();

    assert.ok(notified > 2, 'a single notify is not live progress');
  });

  it('stops sending once closed', async () => {
    const mesh = new FakeMesh();
    const a = mesh.connect('a');
    const d = new Distributor(mesh);
    d.close();

    d.setTracks([track('one')]);
    d.sync(['a']);
    await settle();

    assert.equal(a.sent.length, 0);
  });
});

describe('Receiver', () => {
  /** A member's link to the creator, and the creator's end of it. */
  function wired() {
    const mesh = new FakeMesh();
    const to = mesh.connect('creator');
    const from = channel();
    from.peer = to;
    return { link: mesh.link('creator'), from, to };
  }

  it('keeps each track as it arrives, encoded, by id', async () => {
    const { link, from } = wired();
    const r = new Receiver(link);
    r.start();
    await settle();
    assert.deepEqual(r.download('one'), { state: 'waiting' });

    await send(from, track('one'));
    await send(from, track('two', 20_000));
    await settle();

    assert.equal(r.bytes('one')?.byteLength, 40_000);
    assert.equal(r.bytes('two')?.byteLength, 20_000);
    assert.deepEqual(r.download('two'), { progress: 1, state: 'ready' });
  });

  it('reports how far along the track on the wire is', async () => {
    const { link, from } = wired();
    const r = new Receiver(link);
    const seen: unknown[] = [];
    r.subscribe(() => seen.push(r.download('one')));
    r.start();
    await settle();
    await send(from, track('one'));
    await settle();

    assert.ok(seen.some((d) => (d as { state: string }).state === 'downloading'));
    assert.deepEqual(seen.at(-1), { progress: 1, state: 'ready' });
  });

  it('waits for the creator channel to open rather than giving up', async () => {
    const mesh = new FakeMesh();
    const r = new Receiver(mesh.link('creator'));
    r.start();
    await settle();
    assert.equal(r.stalled(), false);

    const to = mesh.connect('creator');
    const from = channel();
    from.peer = to;
    await settle();
    await send(from, track('one'));
    await settle();

    assert.equal(r.download('one').state, 'ready');
  });

  it('lets go of tracks that are no longer in the playlist', async () => {
    // A phone holding every track ever added runs out of memory.
    const { link, from } = wired();
    const r = new Receiver(link);
    r.start();
    await settle();
    await send(from, track('one'));
    await send(from, track('two'));
    await settle();

    r.keep(['two']);

    assert.equal(r.bytes('one'), undefined);
    assert.ok(r.bytes('two'));
  });

  it('says so when the creator drops, and keeps what it already has', async () => {
    const { link, from, to } = wired();
    const r = new Receiver(link);
    r.start();
    await settle();
    await send(from, track('one'));
    await settle();

    to.close();
    await settle();

    assert.equal(r.stalled(), true);
    assert.ok(r.bytes('one'));
  });
});
