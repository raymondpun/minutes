import { config } from '../config.js';
import { audioPart, generateJson } from '../gemini.js';
import { uploadAudioFromFile } from '../gcs.js';
import { diarizedTranscriptPrompt, TRANSCRIPT_SCHEMA } from '../prompts.js';
import * as store from '../store.js';
import { pcmDurationSeconds, pcmToWav, secondsToByteOffset, wavHeader } from '../wav.js';
import type { TranscriptSegment } from '../types.js';

interface RawSegments {
  segments: TranscriptSegment[];
}

/**
 * Produce the authoritative diarized transcript from the complete recording.
 *
 * Two routes, both ending in the same shape:
 *
 *   With GCS  -- the whole meeting goes to Gemini in one request. Best result,
 *                because the model hears every voice across the full duration
 *                and keeps its speaker labels stable throughout.
 *
 *   Without   -- the recording is cut into overlapping segments and transcribed
 *                in order, each one told which speakers have already been seen.
 *                Works with zero cloud setup; speaker labels drift a little more
 *                across seams, which the identification step then largely fixes
 *                because it works from names, not labels.
 */
export async function buildTranscript(
  meetingId: string,
  expectedAttendees: string[],
  onProgress: (message: string) => void,
): Promise<TranscriptSegment[]> {
  const totalBytes = await store.pcmSize(meetingId);

  if (totalBytes === 0) {
    // The local disk is empty, but on Cloud Run that is the normal state after
    // an instance is reclaimed -- and if the recording was already uploaded,
    // it is sitting complete in the bucket. Telling the user nothing was
    // recorded while their audio is safe in Cloud Storage is the worst
    // possible answer, so look there before giving up.
    if (await gcsAudioAvailable(meetingId)) {
      onProgress('Transcribing the archived recording');
      const result = await generateJson<RawSegments>({
        model: config.models.transcribe,
        label: 'transcribe-archived',
        parts: [
          audioPart({
            gcsUri: `gs://${config.gcsBucket}/meetings/${meetingId}/audio.wav`,
            mimeType: 'audio/wav',
          }),
          {
            text: diarizedTranscriptPrompt({
              offsetSeconds: 0,
              knownSpeakers: [],
              expectedAttendees,
              isFirstSegment: true,
            }),
          },
        ],
        responseSchema: TRANSCRIPT_SCHEMA,
        maxOutputTokens: 65_536,
      });
      return normalise(result.segments ?? [], 0);
    }
    throw new Error('No audio was recorded for this meeting.');
  }

  const totalSeconds = pcmDurationSeconds(totalBytes);
  const wholeWavBytes = totalBytes + 44;

  if (config.gcsBucket) {
    onProgress('Uploading recording');
    // Streamed, not buffered: a two hour meeting is ~230 MB and reading it into
    // memory to prepend 44 bytes doubled that on an instance that is also still
    // holding the app.
    const uri = await uploadAudioFromFile(
      meetingId,
      store.pcmPath(meetingId),
      wavHeader(totalBytes),
    );

    onProgress(`Transcribing ${formatDuration(totalSeconds)} of audio in one pass`);
    const result = await generateJson<RawSegments>({
      model: config.models.transcribe,
      label: 'transcribe-full',
      parts: [
        audioPart({ gcsUri: uri, mimeType: 'audio/wav' }),
        {
          text: diarizedTranscriptPrompt({
            offsetSeconds: 0,
            knownSpeakers: [],
            expectedAttendees,
            isFirstSegment: true,
          }),
        },
      ],
      responseSchema: TRANSCRIPT_SCHEMA,
      maxOutputTokens: 65_536,
    });
    return normalise(result.segments ?? [], 0);
  }

  if (wholeWavBytes <= config.maxInlineAudioBytes) {
    onProgress(`Transcribing ${formatDuration(totalSeconds)} of audio`);
    const pcm = await store.readPcmRange(meetingId, 0, totalBytes);
    const result = await generateJson<RawSegments>({
      model: config.models.transcribe,
      label: 'transcribe-inline',
      parts: [
        audioPart({ bytes: pcmToWav(pcm), mimeType: 'audio/wav' }),
        {
          text: diarizedTranscriptPrompt({
            offsetSeconds: 0,
            knownSpeakers: [],
            expectedAttendees,
            isFirstSegment: true,
          }),
        },
      ],
      responseSchema: TRANSCRIPT_SCHEMA,
      maxOutputTokens: 65_536,
    });
    return normalise(result.segments ?? [], 0);
  }

  // Segmented fallback.
  const { segmentSeconds, segmentOverlapSeconds } = config;
  const stride = segmentSeconds - segmentOverlapSeconds;
  // Counted by stride, the last segment is often a one-second runt whose output
  // is then filtered away entirely -- a wasted model call and a misleading
  // "part 11 of 11". Each segment is stride + overlap long, so count from that.
  const segmentCount =
    totalSeconds <= segmentSeconds
      ? 1
      : Math.ceil((totalSeconds - segmentSeconds) / stride) + 1;

  const all: TranscriptSegment[] = [];
  const knownSpeakers = new Set<string>();
  /** Where one segment's audio ends and the next begins. */
  const seams: number[] = [];

  for (let i = 0; i < segmentCount; i++) {
    const startSec = i * stride;
    if (startSec >= totalSeconds) break;
    const endSec = Math.min(totalSeconds, startSec + segmentSeconds);

    onProgress(
      `Transcribing part ${i + 1} of ${segmentCount} (${formatDuration(startSec)}–${formatDuration(endSec)})`,
    );

    const pcm = await store.readPcmRange(
      meetingId,
      secondsToByteOffset(startSec),
      secondsToByteOffset(endSec),
    );
    if (pcm.length === 0) continue;

    const result = await generateJson<RawSegments>({
      model: config.models.transcribe,
      label: `transcribe-part-${i + 1}`,
      parts: [
        audioPart({ bytes: pcmToWav(pcm), mimeType: 'audio/wav' }),
        {
          text: diarizedTranscriptPrompt({
            offsetSeconds: startSec,
            knownSpeakers: [...knownSpeakers],
            expectedAttendees,
            isFirstSegment: i === 0,
          }),
        },
      ],
      responseSchema: TRANSCRIPT_SCHEMA,
      maxOutputTokens: 65_536,
    });

    // Clamp to the segment's own length. A model that reports a timestamp
    // beyond the clip it was given -- which happens -- would otherwise put a
    // quote minutes away from where it was actually said, and the citation
    // would look perfectly plausible while pointing at the wrong moment.
    const shifted = normalise(result.segments ?? [], startSec, endSec - startSec);
    for (const s of shifted) knownSpeakers.add(s.speaker);

    // Each segment owns a half-open slice of the timeline, splitting every
    // overlap down the middle. The previous filter was a lower bound only, so
    // the trailing half of each overlap was claimed by both neighbours -- about
    // five seconds of speech transcribed and emitted twice at every seam, which
    // dedupe only catches when the two renderings come out character-identical.
    const from = i === 0 ? -Infinity : startSec + segmentOverlapSeconds / 2;
    const until =
      i === segmentCount - 1
        ? Number.POSITIVE_INFINITY
        : (i + 1) * stride + segmentOverlapSeconds / 2;
    if (i > 0) seams.push(startSec);
    all.push(...shifted.filter((s) => s.start >= from && s.start < until));
  }

  // Sorted per segment, but never across them until now. Segment boundaries do
  // not guarantee ordering once anything has been clamped or dropped, and the
  // transcript is read top to bottom by both the model drafting the minutes and
  // the human checking them.
  all.sort((a, b) => a.start - b.start);
  return dedupe(all, seams);
}

/**
 * Clamp nonsense, shift into meeting-relative time, drop empties.
 *
 * `duration` bounds the timestamps to the clip the model was actually given.
 * Without it a hallucinated timestamp lands wherever the model imagined, and
 * since every quote in the minutes is cited by time, a wrong one is worse than
 * a missing one -- it looks correct.
 */
function normalise(
  segments: TranscriptSegment[],
  offset: number,
  duration = Number.POSITIVE_INFINITY,
): TranscriptSegment[] {
  return segments
    .filter((s) => s && typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s) => {
      const start = clamp(Number(s.start) || 0, 0, duration);
      const end = clamp(Number(s.end) || 0, start, duration);
      return {
        start: start + offset,
        end: end + offset,
        speaker: (s.speaker || 'Speaker 1').trim(),
        text: s.text.trim(),
        language: s.language,
      };
    })
    .sort((a, b) => a.start - b.start);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Remove the double-transcription of the overlap between two segments.
 *
 * Matched on text rather than time, because the two segments estimate timings
 * independently and give the same sentence slightly different ones.
 *
 * Restricted to the neighbourhood of a seam. Run across the whole transcript it
 * deletes real speech: in a two hour meeting somebody says 「係」 at 10:00 and
 * somebody else says 「係」 at 10:04, and one of them silently disappears
 * nowhere near a segment boundary. Short confirmations are exactly the words
 * people repeat, so a global text match is guaranteed to eat some of them.
 */
function dedupe(segments: TranscriptSegment[], seams: number[]): TranscriptSegment[] {
  if (seams.length === 0) return segments;

  const WINDOW = config.segmentOverlapSeconds * 2;
  const nearSeam = (t: number) => seams.some((seam) => Math.abs(t - seam) <= WINDOW);

  // Short utterances are never worth de-duplicating. Three people answering a
  // roll call two seconds apart all normalise to "present", and a vote is a row
  // of identical "aye"s -- collapsing those silently falsifies an attendance or
  // voting record, which is the one thing these minutes exist to get right.
  // A duplicated 「係」 costs nothing; a deleted vote costs everything.
  const MIN_DEDUPE_LENGTH = 12;

  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const duplicate =
      nearSeam(s.start) &&
      normaliseText(s.text).length >= MIN_DEDUPE_LENGTH &&
      out.some(
        (prev) =>
          Math.abs(prev.start - s.start) < 6 &&
          normaliseText(prev.text) === normaliseText(s.text),
      );
    if (!duplicate) out.push(s);
  }
  return out;
}

function normaliseText(t: string): string {
  return t.replace(/[\s\p{P}]/gu, '').toLowerCase();
}

async function gcsAudioAvailable(meetingId: string): Promise<boolean> {
  if (!config.gcsBucket) return false;
  try {
    const { audioExists } = await import('../gcs.js');
    return await audioExists(meetingId);
  } catch {
    return false;
  }
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}
