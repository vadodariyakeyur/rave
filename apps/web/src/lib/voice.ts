'use client';

import { setAudioSession } from './audio';
import type { Mesh } from './mesh';

/**
 * Talk mode, on this device: the microphone, whether it is muted, everyone
 * else's voice, and who is speaking.
 *
 * The audio itself travels on the mesh's own connections. This only decides
 * what goes onto them and keeps what comes off, so a re-render or a mode
 * switch cannot change what is being said.
 */

/** Spoken-word level, as the share of full scale: above room noise, below a quiet voice. */
const SPEAKING_LEVEL = 0.02;

/** How often levels are read. Fast enough to feel live, slow enough to cost nothing. */
const LEVEL_TICK_MS = 150;

export const MIC_BLOCKED = 'The microphone is blocked. Allow it in your browser settings to talk.';
export const MIC_MISSING = 'No microphone was found on this device.';

/** RMS of one analyser frame, 0 to 1. Silence is a flat line at 128. */
export function levelOf(frame: Uint8Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += ((sample - 128) / 128) ** 2;
  return Math.sqrt(sum / frame.length);
}

export interface VoiceState {
  micOn: boolean;
  muted: boolean;
  /** Why the microphone could not be turned on, in words for a person. */
  error?: string;
  /** Peer ids currently speaking, this device's own included. */
  speaking: ReadonlySet<string>;
  /** Each other peer's voice, to be played. */
  streams: ReadonlyMap<string, MediaStream>;
}

type VoiceMesh = Pick<Mesh, 'setLocalAudio' | 'onRemoteAudio'>;
type VoiceContext = Pick<AudioContext, 'createMediaStreamSource' | 'createAnalyser'>;
type Every = (ms: number, fn: () => void) => () => void;
type GetMic = () => Promise<MediaStream>;

const realMic: GetMic = () =>
  navigator.mediaDevices.getUserMedia({
    // Echo cancellation first: two open microphones in earshot of each
    // other's speakers is the failure this mode is most prone to.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

const realEvery: Every = (ms, fn) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

interface Meter {
  analyser: AnalyserNode;
  frame: Uint8Array<ArrayBuffer>;
  source: MediaStreamAudioSourceNode;
}

export class Voice {
  readonly #mesh: VoiceMesh;
  readonly #context: VoiceContext;
  readonly #selfPeerId: string;
  readonly #getMic: GetMic;
  readonly #listeners = new Set<() => void>();
  readonly #streams = new Map<string, MediaStream>();
  readonly #meters = new Map<string, Meter>();
  readonly #every: Every;
  readonly #stopListening: () => void;
  /** Only runs while there is a stream to listen to. */
  #stopTicking: (() => void) | undefined;
  #mic: MediaStream | undefined;
  #muted = false;
  #error: string | undefined;
  #speaking: ReadonlySet<string> = new Set();
  #state: VoiceState;
  #closed = false;

  constructor(input: {
    mesh: VoiceMesh;
    context: VoiceContext;
    selfPeerId: string;
    getMic?: GetMic;
    every?: Every;
  }) {
    this.#mesh = input.mesh;
    this.#context = input.context;
    this.#selfPeerId = input.selfPeerId;
    this.#getMic = input.getMic ?? realMic;
    this.#state = this.#build();
    this.#every = input.every ?? realEvery;
    this.#stopListening = input.mesh.onRemoteAudio((peerId, stream) => this.#remote(peerId, stream));
  }

  state(): VoiceState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Ask for the microphone and go live. Must come from a tap on some browsers. */
  async enable(): Promise<void> {
    if (this.#mic || this.#closed) return;
    this.#error = undefined;
    try {
      const mic = await this.#getMic();
      if (this.#closed) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      this.#mic = mic;
      this.#muted = false;
      setAudioSession('play-and-record');
      this.#meter(this.#selfPeerId, mic);
      this.#mesh.setLocalAudio(mic.getAudioTracks()[0] ?? null);
    } catch (err) {
      this.#error = (err as { name?: string }).name === 'NotFoundError' ? MIC_MISSING : MIC_BLOCKED;
    }
    this.#publish();
  }

  /** A muted microphone sends silence on the same line, so nothing renegotiates. */
  setMuted(muted: boolean): void {
    if (!this.#mic) return;
    this.#muted = muted;
    for (const track of this.#mic.getAudioTracks()) track.enabled = !muted;
    this.#publish();
  }

  /** Let go of the microphone, so the browser's recording indicator goes out. */
  release(): void {
    if (!this.#mic) return;
    this.#mesh.setLocalAudio(null);
    for (const track of this.#mic.getTracks()) track.stop();
    this.#mic = undefined;
    this.#muted = false;
    this.#unmeter(this.#selfPeerId);
    setAudioSession('playback');
    this.#publish();
  }

  close(): void {
    if (this.#closed) return;
    this.release();
    this.#closed = true;
    this.#stopListening();
    this.#stopTicking?.();
    this.#stopTicking = undefined;
    for (const peerId of [...this.#meters.keys()]) this.#unmeter(peerId);
    this.#streams.clear();
    this.#listeners.clear();
  }

  #remote(peerId: string, stream: MediaStream | undefined): void {
    if (this.#closed) return;
    this.#unmeter(peerId);
    if (stream) {
      this.#streams.set(peerId, stream);
      this.#meter(peerId, stream);
    } else {
      this.#streams.delete(peerId);
    }
    this.#publish();
  }

  #meter(peerId: string, stream: MediaStream): void {
    try {
      const analyser = this.#context.createAnalyser();
      analyser.fftSize = 512;
      const source = this.#context.createMediaStreamSource(stream);
      // Read from, never played: the stream is heard through its own
      // element, and connecting it to the output as well would double it.
      source.connect(analyser);
      this.#meters.set(peerId, { analyser, source, frame: new Uint8Array(analyser.fftSize) });
      this.#stopTicking ??= this.#every(LEVEL_TICK_MS, () => this.#measure());
    } catch {
      // No meter, so no speaking ring for them. Their voice still plays.
    }
  }

  #unmeter(peerId: string): void {
    const meter = this.#meters.get(peerId);
    if (!meter) return;
    meter.source.disconnect();
    this.#meters.delete(peerId);
    if (this.#meters.size === 0) {
      this.#stopTicking?.();
      this.#stopTicking = undefined;
    }
  }

  #measure(): void {
    const speaking = new Set<string>();
    for (const [peerId, meter] of this.#meters) {
      meter.analyser.getByteTimeDomainData(meter.frame);
      if (levelOf(meter.frame) > SPEAKING_LEVEL) speaking.add(peerId);
    }
    const same =
      speaking.size === this.#speaking.size && [...speaking].every((id) => this.#speaking.has(id));
    if (same) return;
    this.#speaking = speaking;
    this.#publish();
  }

  #publish(): void {
    this.#state = this.#build();
    for (const listener of [...this.#listeners]) listener();
  }

  #build(): VoiceState {
    return {
      micOn: this.#mic !== undefined,
      muted: this.#muted,
      error: this.#error,
      speaking: this.#speaking,
      streams: new Map(this.#streams),
    };
  }
}
