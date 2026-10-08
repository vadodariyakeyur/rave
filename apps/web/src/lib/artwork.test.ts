import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ART_BYTES, artOf } from './artwork.ts';
import { paletteOf } from './palette.ts';

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
const PNG = [0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8];

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const synchsafe = (n: number) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const buf = (...parts: number[][]) => Uint8Array.from(parts.flat()).buffer;

/** One ID3 frame. */
function frame(version: 3 | 4, id: string, body: number[], flags = [0, 0]) {
  return [...ascii(id), ...(version === 4 ? synchsafe(body.length) : be32(body.length)), ...flags, ...body];
}
function apic(picture: number[], type = 3, encoding = 0) {
  const description = encoding === 1 ? [0xff, 0xfe, 0x61, 0, 0, 0] : [0x64, 0];
  return [encoding, ...ascii('image/jpeg'), 0, type, ...description, ...picture];
}
function mp3(version: 3 | 4, frames: number[][], flags = 0) {
  const body = frames.flat();
  return buf(ascii('ID3'), [version, 0, flags], synchsafe(body.length), body, [0, 0, 0, 0, 0, 0]);
}

describe('artwork in an MP3', () => {
  for (const version of [3, 4] as const) {
    it(`reads the picture from ID3v2.${version}`, () => {
      const art = artOf(mp3(version, [frame(version, 'TIT2', [0, 0x61]), frame(version, 'APIC', apic(JPEG))]));
      assert.equal(art?.mime, 'image/jpeg');
      assert.deepEqual([...art!.data], JPEG);
    });
  }

  it('prefers the front cover over an earlier picture, and judges the format by the bytes', () => {
    const art = artOf(mp3(3, [frame(3, 'APIC', apic(JPEG, 4)), frame(3, 'APIC', apic(PNG, 3))]));
    assert.equal(art?.mime, 'image/png');
  });

  it('copes with a UTF-16 description', () => {
    const art = artOf(mp3(4, [frame(4, 'APIC', apic(JPEG, 3, 1))]));
    assert.deepEqual([...art!.data], JPEG);
  });

  it('gives nothing for a tag with no picture, or a picture that is not an image', () => {
    assert.equal(artOf(mp3(3, [frame(3, 'TIT2', [0, 0x61])])), undefined);
    assert.equal(artOf(mp3(3, [frame(3, 'APIC', apic([1, 2, 3, 4, 5]))])), undefined);
  });

  it('gives nothing for a tag cut off mid-picture, or one whose frame claims to be bigger than the file', () => {
    const whole = new Uint8Array(mp3(3, [frame(3, 'APIC', apic(JPEG))]));
    assert.equal(artOf(whole.slice(0, 30).buffer), undefined);
    const lying = new Uint8Array(whole);
    lying.set(be32(0x7fffffff), 14); // the frame's size field
    assert.equal(artOf(lying.buffer), undefined);
  });
});

describe('artwork in an M4A', () => {
  const box = (type: string, ...children: number[][]) => {
    const body = children.flat();
    return [...be32(8 + body.length), ...ascii(type), ...body];
  };
  const file = (picture: number[]) =>
    buf(
      box('ftyp', ascii('M4A '), be32(0)),
      box('moov', box('udta', box('meta', be32(0), box('ilst', box('covr', box('data', be32(13), be32(0), picture)))))),
    );

  it('reads the picture from the covr atom', () => {
    const art = artOf(file(JPEG));
    assert.equal(art?.mime, 'image/jpeg');
    assert.deepEqual([...art!.data], JPEG);
  });

  it('finds the picture in a later udta, after an encoder\'s own metadata (as real files have)', () => {
    const own = box('udta', box('meta', be32(0), box('hdlr', new Array(20).fill(0)), box('ilst', box('\u00a9too', box('data', be32(1), be32(0), ascii('enc'))))));
    const tagged = box('udta', box('meta', be32(0), box('ilst', box('covr', box('data', be32(13), be32(0), JPEG)))));
    const art = artOf(buf(box('ftyp', ascii('M4A '), be32(0)), box('moov', box('trak'), own, tagged)));
    assert.deepEqual([...art!.data], JPEG);
  });

  it('gives nothing without one, or when cut short', () => {
    assert.equal(artOf(buf(box('ftyp', ascii('M4A '), be32(0)), box('moov'))), undefined);
    assert.equal(artOf(file(JPEG).slice(0, 50)), undefined);
  });
});

describe('artwork in a FLAC', () => {
  const picture = (data: number[], type = 3) => [
    ...be32(type), ...be32(10), ...ascii('image/jpeg'), ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0),
    ...be32(data.length), ...data,
  ];
  const block = (kind: number, body: number[], last: boolean) => [
    (last ? 0x80 : 0) | kind, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body,
  ];

  it('reads the picture block', () => {
    const art = artOf(buf(ascii('fLaC'), block(0, new Array(34).fill(0), false), block(6, picture(JPEG), true)));
    assert.deepEqual([...art!.data], JPEG);
  });

  it('gives nothing when the block is cut short', () => {
    const whole = new Uint8Array(buf(ascii('fLaC'), block(6, picture(JPEG), true)));
    assert.equal(artOf(whole.slice(0, whole.length - 3).buffer), undefined);
  });
});

describe('whatever else turns up', () => {
  it('is no picture, and never throws', () => {
    assert.equal(artOf(new ArrayBuffer(0)), undefined);
    assert.equal(artOf(buf([1, 2, 3])), undefined);
    assert.equal(artOf(Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 256).buffer), undefined);
    assert.equal(artOf(buf(ascii('RIFF'), new Array(60).fill(0))), undefined);
  });

  it('refuses a picture bigger than the cap', () => {
    const huge = [...JPEG, ...new Array(MAX_ART_BYTES).fill(0)];
    assert.equal(artOf(mp3(3, [frame(3, 'APIC', apic(huge))])), undefined);
  });
});

describe('paletteOf', () => {
  const pixels = (...colours: [number, number, number][]) =>
    Uint8ClampedArray.from(colours.flatMap(([r, g, b]) => [r, g, b, 255]));

  it('picks the most colourful hues, heaviest first', () => {
    const palette = paletteOf(pixels(...Array(30).fill([220, 30, 60]), ...Array(10).fill([40, 80, 220])))!;
    assert.match(palette[0], /^rgb\(2[0-9]{2} /);
    assert.match(palette[1], /^rgb\(\d+ \d+ 2[0-9]{2}\)$/);
  });

  it('uses one colour twice when that is all there is', () => {
    const palette = paletteOf(pixels([220, 30, 60], [220, 30, 60]))!;
    assert.equal(palette[0], palette[1]);
  });

  it('gives nothing for grey, black, white or transparent pictures', () => {
    assert.equal(paletteOf(pixels([128, 128, 128], [0, 0, 0], [255, 255, 255])), undefined);
    assert.equal(paletteOf(Uint8ClampedArray.from([220, 30, 60, 0])), undefined);
    assert.equal(paletteOf(new Uint8ClampedArray(0)), undefined);
  });
});
