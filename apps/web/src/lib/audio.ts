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

/** Must be called synchronously from a user gesture handler. */
export async function armAudio(ctx: AudioContext): Promise<void> {
  if (ctx.state !== 'running') await ctx.resume();
  // Resuming is not enough on iOS: a source has to actually have played.
  const silence = ctx.createBufferSource();
  silence.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  silence.connect(ctx.destination);
  silence.start();
}

export async function decodeFile(ctx: AudioContext, file: File): Promise<DecodedTrack> {
  const bytes = await file.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches the buffer, so peers get their own copy later.
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(DECODE_ERROR);
  }
  // A zero-length decode is a "success" no one can listen to. Treat it as
  // failure here, while nobody is waiting in a room.
  if (!buffer.duration || buffer.duration <= 0) throw new Error(DECODE_ERROR);
  return { buffer, durationSeconds: buffer.duration };
}
