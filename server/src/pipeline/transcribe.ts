import { config } from '../config.js';
import { audioPart, generateJson } from '../gemini.js';
import { uploadAudio } from '../gcs.js';
import { diarizedTranscriptPrompt, TRANSCRIPT_SCHEMA } from '../prompts.js';
import * as store from '../store.js';
import { pcmDurationSeconds, pcmToWav, secondsToByteOffset } from '../wav.js';
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
  if (totalBytes === 0) throw new Error('No audio was recorded for this meeting.');

  const totalSeconds = pcmDurationSeconds(totalBytes);
  const wholeWavBytes = totalBytes + 44;

  if (config.gcsBucket) {
    onProgress('Uploading recording');
    const pcm = await store.readPcmRange(meetingId, 0, totalBytes);
    const uri = await uploadAudio(meetingId, pcmToWav(pcm));

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
  const segmentCount = Math.max(1, Math.ceil(totalSeconds / stride));

  const all: TranscriptSegment[] = [];
  const knownSpeakers = new Set<string>();

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

    // Drop anything landing inside the overlap we already transcribed, so the
    // seam does not produce a duplicated sentence.
    const cutoff = i === 0 ? -Infinity : startSec + segmentOverlapSeconds / 2;
    all.push(...shifted.filter((s) => s.start >= cutoff));
  }

  // Sorted per segment, but never across them until now. Segment boundaries do
  // not guarantee ordering once anything has been clamped or dropped, and the
  // transcript is read top to bottom by both the model drafting the minutes and
  // the human checking them.
  all.sort((a, b) => a.start - b.start);
  return dedupe(all);
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
 * Overlapping segments occasionally yield the same sentence twice with slightly
 * different timings. Match on text rather than time.
 */
function dedupe(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const duplicate = out.some(
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

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}
