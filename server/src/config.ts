import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

/**
 * Audio format used end to end. The browser downsamples whatever the mic gives
 * us to this, we stream raw PCM to the server, and the server wraps it in a WAV
 * header on the way to Gemini. 16 kHz mono is what speech models want anyway --
 * sending 48 kHz stereo would cost 6x the bytes for no accuracy gain.
 */
export const AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
} as const;

export const bytesPerSecond =
  AUDIO.sampleRate * AUDIO.channels * AUDIO.bytesPerSample;

export const config = {
  port: Number(process.env.PORT ?? 8080),

  projectId: required('GOOGLE_CLOUD_PROJECT'),
  location: process.env.GOOGLE_CLOUD_LOCATION ?? 'asia-southeast1',

  models: {
    live: process.env.MODEL_LIVE ?? 'gemini-3.6-flash',
    transcribe: process.env.MODEL_TRANSCRIBE ?? 'gemini-3.6-flash',
    minutes: process.env.MODEL_MINUTES ?? 'gemini-3.6-flash',
  },

  gcsBucket: process.env.GCS_BUCKET || undefined,

  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),

  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Vertex caps the size of an inline request payload. We stay well under it so
   * the base64 expansion (+33%) plus the prompt still fits. Anything larger goes
   * to GCS if a bucket is configured, or gets segmented if not.
   */
  maxInlineAudioBytes: 14 * 1024 * 1024,

  /** Segment length when falling back to chunked transcription (no GCS). */
  segmentSeconds: 8 * 60,

  /** Overlap between segments so a sentence split across the seam survives. */
  segmentOverlapSeconds: 10,
} as const;

export type Config = typeof config;
