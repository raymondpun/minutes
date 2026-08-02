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

export const WAV_HEADER_BYTES = 44;

/**
 * 10 MB of audio becomes ~13.4 MB of base64, which leaves comfortable room for
 * the prompt inside a request limit of around 20 MB.
 */
const MAX_INLINE_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Audio retention. `0` deletes as soon as the minutes exist; a number keeps it
 * that many days; `forever` (or any negative number) keeps it indefinitely.
 *
 * Storage is not the constraint -- 16 kHz mono is about 115 MB an hour, so a
 * hundred two-hour meetings is roughly fifty US cents a month, and pennies once
 * the lifecycle rules age them into colder classes. The reason to bound it is
 * that these are recordings of colleagues' voices, and "indefinitely" should be
 * a decision somebody made rather than a default nobody noticed.
 */
function parseRetention(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 30;
  if (/^forever$|^never$|^indefinite/i.test(raw.trim())) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return n < 0 ? Number.POSITIVE_INFINITY : n;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  projectId: required('GOOGLE_CLOUD_PROJECT'),
  location: process.env.GOOGLE_CLOUD_LOCATION ?? 'asia-southeast1',

  models: {
    live: process.env.MODEL_LIVE ?? 'gemini-3.6-flash',
    digest: process.env.MODEL_DIGEST ?? 'gemini-3.6-flash',
    transcribe: process.env.MODEL_TRANSCRIBE ?? 'gemini-3.6-flash',
    minutes: process.env.MODEL_MINUTES ?? 'gemini-3.6-flash',
  },

  gcsBucket: process.env.GCS_BUCKET || undefined,

  /**
   * How long to keep the recording after the minutes are drafted.
   *
   * 0 deletes it immediately, which is the strongest privacy posture and lets
   * you tell the room the recording does not survive. Anything higher keeps it
   * so a disputed minute can be settled by listening to what was actually said
   * -- the quotes already carry timestamps, so this turns the evidence layer
   * from "trust the translation" into "play the eight seconds".
   *
   * Bounded on purpose. Voice recordings of colleagues accumulating forever is
   * a records-retention decision nobody consciously made; a month is long
   * enough to settle an argument about last week's meeting.
   */
  retainAudioDays: parseRetention(process.env.RETAIN_AUDIO_DAYS),

  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),

  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Ceiling on audio sent inline in a request.
   *
   * Inline data is base64 encoded, so this becomes ~4/3 this size on the wire,
   * and the prompt rides along with it. Vertex rejects the whole request past
   * its limit, so the binary cap has to leave room for both.
   */
  maxInlineAudioBytes: MAX_INLINE_AUDIO_BYTES,

  /**
   * Segment length for the fallback path when no GCS bucket is configured.
   *
   * DERIVED, not chosen. This was hardcoded at 8 minutes, which produces a
   * 15.4 MB WAV -- 19.5 MB once base64 encoded, and over the inline cap this
   * same config file declares. Every meeting longer than one segment would
   * have failed, in the default no-bucket setup, on a request the code had
   * already been told was too big.
   *
   * Shorter segments mean more seams and slightly more speaker-label drift.
   * The real fix is a GCS bucket, which sends the meeting in one pass.
   */
  segmentSeconds: Math.floor((MAX_INLINE_AUDIO_BYTES - WAV_HEADER_BYTES) / bytesPerSecond),

  /** Overlap between segments so a sentence split across the seam survives. */
  segmentOverlapSeconds: 10,

  /**
   * The live pass batches audio before transcribing it, and the batch size
   * ramps.
   *
   * Short chunks at the start because the first job is confirming the mic hears
   * everyone, and you want to know that within seconds, not a minute. Longer
   * chunks afterwards because the second job is scrollback -- being able to
   * check at 01:30 what was said at 00:30 -- and for that, fewer larger blocks
   * read better than a hundred fragments.
   *
   * It is also most of the cost. Every chunk re-sends the same language rules,
   * so at 20s the prompt overhead is nearly half the input tokens. Tripling the
   * chunk length past the mic-check window cuts the live pass by about a third
   * and loses nothing.
   */
  live: {
    initialChunkSeconds: Number(process.env.LIVE_INITIAL_CHUNK_SECONDS ?? 20),
    steadyChunkSeconds: Number(process.env.LIVE_STEADY_CHUNK_SECONDS ?? 60),
    rampAfterSeconds: Number(process.env.LIVE_RAMP_AFTER_SECONDS ?? 180),
  },

  /**
   * How often to fold the live transcript into a summary block. Five minutes is
   * long enough for a topic to have a shape and short enough that the block
   * boundaries roughly track the agenda.
   */
  digestIntervalSeconds: Number(process.env.DIGEST_INTERVAL_SECONDS ?? 300),

  rollCall: {
    /** Give up waiting for introductions to end and start the meeting anyway. */
    maxSeconds: Number(process.env.ROLL_CALL_MAX_SECONDS ?? 240),
  },
} as const;

export type Config = typeof config;

/**
 * How much audio to batch before sending it off for a live transcription,
 * given how long the meeting has been running.
 */
export function liveChunkBytes(elapsedSeconds: number): number {
  const { initialChunkSeconds, steadyChunkSeconds, rampAfterSeconds } = config.live;
  const seconds =
    elapsedSeconds < rampAfterSeconds ? initialChunkSeconds : steadyChunkSeconds;
  return seconds * bytesPerSecond;
}
