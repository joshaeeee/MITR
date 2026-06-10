// Small shared helpers for the benchmark: WAV<->PCM and frame splitting.

export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Extract raw PCM16 samples from a WAV file buffer (skips to the data chunk). */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.subarray(0, 4).toString() !== "RIFF") {
    return { pcm: wav, sampleRate: 16000 }; // assume already raw pcm
  }
  let offset = 12;
  let sampleRate = 16000;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString();
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = wav.readUInt32LE(offset + 12);
    if (id === "data") return { pcm: wav.subarray(offset + 8, offset + 8 + size), sampleRate };
    offset += 8 + size + (size & 1);
  }
  return { pcm: Buffer.alloc(0), sampleRate };
}

export function splitFrames(pcm: Buffer, frameBytes: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += frameBytes) {
    frames.push(pcm.subarray(i, Math.min(i + frameBytes, pcm.length)));
  }
  return frames;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
}
