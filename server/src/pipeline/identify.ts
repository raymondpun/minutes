import { config } from '../config.js';
import { generateJson } from '../gemini.js';
import { identifySpeakersPrompt, SPEAKERS_SCHEMA } from '../prompts.js';
import type { SpeakerIdentification, TranscriptSegment } from '../types.js';

interface RawSpeakers {
  speakers: Array<Omit<SpeakerIdentification, 'segmentCount'>>;
}

/**
 * Map "Speaker 1" to a real person, using the roll-call at the start of the
 * meeting plus every time someone is addressed by name afterwards.
 *
 * This is text-only -- it reads the transcript, not the audio. No voiceprints are
 * computed or stored anywhere, which keeps the app clear of biometric data and
 * means it cannot recognise anyone in a future meeting. That limitation is
 * deliberate.
 */
export async function identifySpeakers(
  transcript: TranscriptSegment[],
  expectedAttendees: string[],
  rollCallEndedAt?: number,
): Promise<SpeakerIdentification[]> {
  const counts = new Map<string, number>();
  for (const s of transcript) {
    counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  // The roll call is at the start, but names get used all the way through, so
  // send the opening in full plus a sample of the rest rather than truncating.
  // When the chair marked the end of the roll call we know exactly how much of
  // the opening matters; otherwise fall back to the first few minutes.
  const openingEnds = rollCallEndedAt ? rollCallEndedAt + 60 : 240;
  const opening = transcript.filter((s) => s.start <= openingEnds);
  const rest = transcript.filter((s) => s.start > openingEnds);
  const sampled = rest.length > 400 ? everyNth(rest, Math.ceil(rest.length / 400)) : rest;

  const result = await generateJson<RawSpeakers>({
    model: config.models.transcribe,
    label: 'identify-speakers',
    parts: [
      {
        text: identifySpeakersPrompt({
          transcript: [...opening, ...sampled],
          expectedAttendees,
        }),
      },
    ],
    responseSchema: SPEAKERS_SCHEMA,
    maxOutputTokens: 8_192,
  });

  const byId = new Map(
    (result.speakers ?? []).map((s) => [s.speakerId, s] as const),
  );

  // Drive the output from the labels that actually appear in the transcript, so
  // a hallucinated extra speaker cannot get into the roster.
  return [...counts.entries()]
    .sort((a, b) => compareSpeakerLabel(a[0], b[0]))
    .map(([speakerId, segmentCount]) => {
      const found = byId.get(speakerId);
      const name = found?.name?.trim();
      return {
        speakerId,
        name: name && name.length > 0 ? name : null,
        role: found?.role?.trim() || null,
        confidence: found?.confidence ?? 'low',
        evidence: found?.evidence ?? null,
        evidenceTime: found?.evidenceTime ?? null,
        segmentCount,
      };
    });
}

/** Rewrite the transcript in place so speakers carry names instead of labels. */
export function applySpeakerNames(
  transcript: TranscriptSegment[],
  speakers: SpeakerIdentification[],
): TranscriptSegment[] {
  const nameFor = new Map(
    speakers.filter((s) => s.name).map((s) => [s.speakerId, s.name!] as const),
  );
  return transcript.map((s) => ({ ...s, speaker: nameFor.get(s.speaker) ?? s.speaker }));
}

function everyNth<T>(items: T[], n: number): T[] {
  return items.filter((_, i) => i % n === 0);
}

function compareSpeakerLabel(a: string, b: string): number {
  const na = Number(a.match(/\d+/)?.[0] ?? NaN);
  const nb = Number(b.match(/\d+/)?.[0] ?? NaN);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}
