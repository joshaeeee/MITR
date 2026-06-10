// PCM16 mono little-endian helpers. All buffers are raw int16 LE samples.

/** Root-mean-square amplitude (0..32767) of an int16 LE buffer. */
export function rms(buf: Buffer): number {
  const n = buf.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i << 1);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Apply a linear gain to int16 LE audio, clipping to int16 range. Mutating-free. */
export function applyGain(buf: Buffer, gain: number): Buffer {
  if (gain === 1.0) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const scaled = Math.round(buf.readInt16LE(i << 1) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i << 1);
  }
  // Preserve a trailing odd byte if any (shouldn't happen for PCM16).
  if (buf.length & 1) out[buf.length - 1] = buf[buf.length - 1]!;
  return out;
}

/**
 * Linear-interpolation resampler for mono int16 LE audio.
 * Good enough (and fast) for 24k->16k downsampling of TTS output.
 */
export function resampleLinear(buf: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return buf;
  const inN = buf.length >> 1;
  if (inN === 0) return Buffer.alloc(0);
  const outN = Math.max(1, Math.round((inN * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outN * 2);
  const ratio = (inN - 1) / Math.max(1, outN - 1);
  for (let i = 0; i < outN; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inN - 1, i0 + 1);
    const frac = pos - i0;
    const s0 = buf.readInt16LE(i0 << 1);
    const s1 = buf.readInt16LE(i1 << 1);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i << 1);
  }
  return out;
}

/** Wrap mono int16 LE PCM in a 44-byte WAV (RIFF) header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** ms of audio represented by an int16 LE buffer at the given sample rate. */
export function durationMs(buf: Buffer, sampleRate: number): number {
  return ((buf.length >> 1) / sampleRate) * 1000;
}

/**
 * Accumulates arbitrary PCM buffers and emits fixed-size frames (e.g. 640 B / 20 ms).
 * The ESP32 truncates any downlink frame larger than 640 B, so all outbound audio
 * MUST be chunked to <= frameBytes.
 */
export class PcmFramer {
  private readonly frameBytes: number;
  private buf: Buffer = Buffer.alloc(0);

  constructor(frameBytes: number) {
    // Force even (whole samples).
    this.frameBytes = frameBytes - (frameBytes & 1);
  }

  /** Push audio; returns any complete frames now available. */
  push(chunk: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= this.frameBytes) {
      frames.push(this.buf.subarray(0, this.frameBytes));
      this.buf = this.buf.subarray(this.frameBytes);
    }
    return frames;
  }

  /** Emit any buffered remainder (zero-padded to whole samples) and reset. */
  flush(): Buffer | null {
    if (this.buf.length === 0) return null;
    let out = this.buf;
    if (out.length & 1) out = Buffer.concat([out, Buffer.alloc(1)]); // whole samples only
    this.buf = Buffer.alloc(0);
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
