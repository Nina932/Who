/**
 * Minimal WAV reading and writing.
 *
 * Only what the speech probe needs: decode what Groq returns so the mechanical
 * chain can be applied to it offline, and write the result back out so it can
 * actually be listened to. Not a general audio library — it handles integer
 * PCM and 32-bit float, which is the whole of what this endpoint emits.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets. Real encoders
 * insert `LIST` and `fact` chunks ahead of `data`, and code that seeks to byte
 * 44 reads those as samples and produces a burst of noise.
 */

export interface Pcm {
  sampleRate: number;
  /** One Float32Array per channel, samples nominally in -1..1. */
  channels: Float32Array[];
}

const ascii = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

export function decodeWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file.");
  }

  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: { start: number; length: number } | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-chunk GUID,
      // whose first two bytes are the format tag.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      data = { start: body, length: Math.min(size, bytes.byteLength - body) };
    }

    // Chunks are word-aligned; an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!data || !channelCount || !sampleRate) throw new Error("WAVE file has no readable fmt/data chunk.");

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const at = data.start + (frame * channelCount + channel) * bytesPerSample;
      let value: number;
      if (format === 3 && bitsPerSample === 32) value = view.getFloat32(at, true);
      else if (bitsPerSample === 16) value = view.getInt16(at, true) / 32_768;
      else if (bitsPerSample === 32) value = view.getInt32(at, true) / 2_147_483_648;
      else if (bitsPerSample === 24) {
        const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        value = raw / 8_388_608;
      } else if (bitsPerSample === 8) value = (view.getUint8(at) - 128) / 128;
      else throw new Error(`Unsupported sample width: ${bitsPerSample} bits.`);
      channels[channel][frame] = value;
    }
  }

  return { sampleRate, channels };
}

/**
 * Wrap raw little-endian 16-bit PCM in a WAV header, sample-for-sample.
 *
 * Some providers return bare PCM with no container — Gemini's speech models
 * describe the encoding in a MIME type and hand back nothing else. A browser
 * cannot decode that: `decodeAudioData` needs a container to know the rate and
 * width. Going through float and re-quantising would work and would also throw
 * away a bit of precision for no reason, so the samples are copied untouched
 * and only a header is prepended.
 */
export function wavFromPcm16(
  pcm: Uint8Array,
  sampleRate: number,
  channelCount = 1,
): Uint8Array {
  // An odd trailing byte is half a sample and cannot be played.
  const usable = pcm.byteLength - (pcm.byteLength % (2 * channelCount));
  const bytes = new Uint8Array(44 + usable);
  const view = new DataView(bytes.buffer);

  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, 36 + usable, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, usable, true);
  bytes.set(pcm.subarray(0, usable), 44);

  return bytes;
}

/**
 * Read the sample rate out of a MIME type like
 * `audio/L16;codec=pcm;rate=24000`, which is how the rate is communicated when
 * the audio itself carries no header.
 */
export function sampleRateFromMimeType(mimeType: string, fallback = 24_000): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  const rate = match ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

/** Write 16-bit PCM, the format every player on every platform opens. */
export function encodeWav(pcm: Pcm): Uint8Array {
  const channelCount = pcm.channels.length;
  if (channelCount === 0) throw new Error("Cannot encode a file with no channels.");
  const frames = pcm.channels[0].length;
  const dataLength = frames * channelCount * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);

  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataLength, true);

  let at = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      // Clamped, not wrapped: an overflowing sample should distort, not flip
      // sign and click.
      const clamped = Math.max(-1, Math.min(1, pcm.channels[channel][frame]));
      view.setInt16(at, Math.round(clamped * 32_767), true);
      at += 2;
    }
  }

  return bytes;
}
