/**
 * The picture a music file carries inside itself, read from bytes a device
 * already holds. Nothing here touches the network or the wire: the creator
 * reads it when it adds a file, and a member reads it from the track it was
 * sent.
 *
 * MP3 (ID3v2), M4A (the `covr` atom) and FLAC (a picture block). Everything
 * read is untrusted, so every offset is checked: a DataView throws on a read
 * past the end, and that, caught once at the top, is the whole bounds check.
 * Anything wrong, anything unrecognised, anything too big is simply no
 * picture, and the track gets its generated cover.
 */

export interface Art {
  mime: 'image/jpeg' | 'image/png';
  data: Uint8Array;
}

/** A picture larger than this is not worth decoding on a phone. */
export const MAX_ART_BYTES = 8 * 1024 * 1024;

const FRONT_COVER = 3;

export function artOf(bytes: ArrayBuffer): Art | undefined {
  try {
    const view = new DataView(bytes);
    const found = view.byteLength < 12 ? undefined : (id3(view) ?? mp4(view) ?? flac(view));
    return found && imageOf(found.data);
  } catch {
    return undefined;
  }
}

/** What a candidate picture is, by its own first bytes rather than by what the tag claims. */
function imageOf(data: Uint8Array): Art | undefined {
  if (data.byteLength === 0 || data.byteLength > MAX_ART_BYTES) return undefined;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: 'image/jpeg', data };
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { mime: 'image/png', data };
  }
  return undefined;
}

interface Candidate {
  /** ID3 and FLAC number their pictures; 3 is the front cover. */
  type: number;
  data: Uint8Array;
}

/** The front cover if there is one, else the first picture. */
function best(candidates: Candidate[]): { data: Uint8Array } | undefined {
  return candidates.find((c) => c.type === FRONT_COVER) ?? candidates[0];
}

const text = (view: DataView, at: number, length: number) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, length));

const slice = (view: DataView, at: number, length: number) => {
  if (at < 0 || length < 0 || at + length > view.byteLength) throw new RangeError('past the end');
  return new Uint8Array(view.buffer, view.byteOffset + at, length);
};

// ---- MP3: ID3v2.3 and v2.4 ------------------------------------------------

const synchsafe = (view: DataView, at: number) =>
  ((view.getUint8(at) & 0x7f) << 21) |
  ((view.getUint8(at + 1) & 0x7f) << 14) |
  ((view.getUint8(at + 2) & 0x7f) << 7) |
  (view.getUint8(at + 3) & 0x7f);

function id3(view: DataView): { data: Uint8Array } | undefined {
  if (text(view, 0, 3) !== 'ID3') return undefined;
  const major = view.getUint8(3);
  // v2.2 uses three-letter frames and is long gone; not worth a second parser.
  if (major !== 3 && major !== 4) return undefined;
  const flags = view.getUint8(5);
  // A whole-tag unsynchronisation (v2.3) would need undoing before any frame
  // could be read. Rare enough to treat as no picture.
  if (major === 3 && flags & 0x80) return undefined;

  let at = 10;
  const end = Math.min(view.byteLength, 10 + synchsafe(view, 6));
  if (flags & 0x40) {
    // An extended header, which carries its own length.
    at += major === 4 ? synchsafe(view, at) : 4 + view.getUint32(at);
  }

  const found: Candidate[] = [];
  while (at + 10 <= end && view.getUint8(at) !== 0) {
    const id = text(view, at, 4);
    const size = major === 4 ? synchsafe(view, at + 4) : view.getUint32(at + 4);
    const frameFlags = view.getUint16(at + 8);
    const body = at + 10;
    if (body + size > end) break;
    // v2.4 frame flags: bit 1 is unsynchronisation, bit 0 a data length prefix.
    const unsynchronised = major === 4 && (frameFlags & 0x0002) !== 0;
    const lengthPrefix = major === 4 && (frameFlags & 0x0001) !== 0 ? 4 : 0;
    if (id === 'APIC' && !unsynchronised) {
      const picture = apic(view, body + lengthPrefix, body + size);
      if (picture) found.push(picture);
    }
    at = body + size;
  }
  return best(found);
}

function apic(view: DataView, from: number, to: number): Candidate | undefined {
  const encoding = view.getUint8(from);
  let at = from + 1;
  while (at < to && view.getUint8(at) !== 0) at++; // the mime type, ended by a zero
  at += 2; // that zero, and the picture type
  const type = view.getUint8(at - 1);
  // The description is in the tag's encoding; UTF-16 ends in a double zero on a 2-byte boundary.
  if (encoding === 1 || encoding === 2) {
    while (at + 1 < to && !(view.getUint8(at) === 0 && view.getUint8(at + 1) === 0)) at += 2;
    at += 2;
  } else {
    while (at < to && view.getUint8(at) !== 0) at++;
    at += 1;
  }
  return at < to ? { type, data: slice(view, at, to - at) } : undefined;
}

// ---- M4A: moov > udta > meta > ilst > covr > data -------------------------

function* boxes(view: DataView, from: number, to: number) {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = text(view, at + 4, 4);
    let header = 8;
    if (size === 1) {
      // A 64-bit size. A box that large cannot be in a buffer this size anyway.
      const high = view.getUint32(at + 8);
      if (high !== 0) return;
      size = view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

/**
 * Every picture under moov > udta > meta > ilst > covr. All matching boxes at
 * each level are searched, not the first: encoders write their own `udta`, and
 * a tagger may add another beside it.
 */
function covers(view: DataView, from: number, to: number, path: string[]): Candidate[] {
  const [step, ...rest] = path;
  const found: Candidate[] = [];
  for (const box of boxes(view, from, to)) {
    if (box.type !== step) continue;
    if (rest.length > 0) {
      // `meta` is a full box: four bytes of version and flags before its children.
      found.push(...covers(view, step === 'meta' ? box.start + 4 : box.start, box.end, rest));
      continue;
    }
    for (const entry of boxes(view, box.start, box.end)) {
      // `data`: four bytes of type, four of locale, then the picture.
      if (entry.type === 'data' && entry.start + 8 <= entry.end) {
        found.push({ type: 0, data: slice(view, entry.start + 8, entry.end - entry.start - 8) });
      }
    }
  }
  return found;
}

function mp4(view: DataView): { data: Uint8Array } | undefined {
  if (text(view, 4, 4) !== 'ftyp') return undefined;
  return best(covers(view, 0, view.byteLength, ['moov', 'udta', 'meta', 'ilst', 'covr']));
}

// ---- FLAC: a METADATA_BLOCK_PICTURE ---------------------------------------

function flac(view: DataView): { data: Uint8Array } | undefined {
  if (text(view, 0, 4) !== 'fLaC') return undefined;
  const found: Candidate[] = [];
  let at = 4;
  for (;;) {
    const header = view.getUint8(at);
    const length = (view.getUint8(at + 1) << 16) | view.getUint16(at + 2);
    const body = at + 4;
    if (body + length > view.byteLength) break;
    if ((header & 0x7f) === 6) {
      const type = view.getUint32(body);
      let p = body + 4;
      p += 4 + view.getUint32(p); // mime
      p += 4 + view.getUint32(p); // description
      p += 16; // width, height, depth, colours
      const size = view.getUint32(p);
      found.push({ type, data: slice(view, p + 4, size) });
    }
    if (header & 0x80) break;
    at = body + length;
  }
  return best(found);
}
