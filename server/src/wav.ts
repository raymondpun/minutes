import { AUDIO } from './config.js';

/**
 * Wrap raw little-endian 16-bit PCM in a WAV header.
 *
 * We keep the audio as headerless PCM on disk because PCM concatenates
 * trivially -- appending the next 20 seconds is just an append. Container
 * formats do not, which is the whole reason this app streams PCM rather than
 * MediaRecorder blobs.
 */
export function pcmToWav(pcm: Buffer, sampleRate = AUDIO.sampleRate): Buffer {
  const channels = AUDIO.channels;
  const bitsPerSample = AUDIO.bytesPerSample * 8;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function pcmDurationSeconds(byteLength: number): number {
  return byteLength / (AUDIO.sampleRate * AUDIO.channels * AUDIO.bytesPerSample);
}

export function secondsToByteOffset(seconds: number): number {
  const raw = Math.floor(seconds * AUDIO.sampleRate) * AUDIO.channels * AUDIO.bytesPerSample;
  // Must land on a sample boundary or the audio turns to static.
  return raw - (raw % (AUDIO.channels * AUDIO.bytesPerSample));
}
