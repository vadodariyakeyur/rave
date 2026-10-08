/**
 * Autoplay policy only lets an AudioContext start from a real user gesture.
 * Every entry point into a room is therefore a tap, and this runs inside it —
 * there is no way to recover later, and the failure is silence at playback
 * with no error anywhere.
 */
export const DECODE_ERROR =
  "That file couldn't be decoded. Try a WAV, MP3, M4A, FLAC or OGG file.";

export interface DecodedTrack {
  buffer: AudioBuffer;
  durationSeconds: number;
}

/**
 * Which kind of audio this page is, to iOS.
 *
 * "playback" is what a music app is: it survives the lock screen and the
 * ringer switch. A microphone needs "play-and-record" instead, so that is
 * only set while one is on. Safari 16.4+; nothing to do elsewhere.
 */
export function setAudioSession(type: 'playback' | 'play-and-record'): void {
  if (typeof navigator === 'undefined') return;
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = type;
}

/** Must be called synchronously from a user gesture handler. */
export async function armAudio(ctx: AudioContext): Promise<void> {
  // iOS files a page that only uses Web Audio under "ambient" sound, which
  // the lock screen and the ringer switch both silence.
  setAudioSession('playback');
  if (ctx.state !== 'running') await ctx.resume();
  // Resuming is not enough on iOS: a source has to actually have played.
  const silence = ctx.createBufferSource();
  silence.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  silence.connect(ctx.destination);
  silence.start();
}

/**
 * Decode encoded audio, leaving the caller's bytes intact.
 *
 * decodeAudioData detaches what it is given, so it gets a copy: the creator
 * has to send those same bytes to every peer afterwards, and a joiner keeps
 * them so a peer arriving later can be served from any device, not only the
 * creator's.
 */
export async function decodeBytes(
  ctx: Pick<AudioContext, 'decodeAudioData'>,
  bytes: ArrayBuffer,
): Promise<DecodedTrack> {
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(DECODE_ERROR);
  }
  // A zero-length decode is a "success" no one can listen to. Treat it as
  // failure here, while nobody is waiting in a room.
  if (!buffer.duration || buffer.duration <= 0) throw new Error(DECODE_ERROR);
  return { buffer, durationSeconds: buffer.duration };
}
