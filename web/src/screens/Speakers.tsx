import { useState } from 'react';
import type { SpeakerIdentification, TranscriptSegment } from '../types';

interface Props {
  speakers: SpeakerIdentification[];
  transcript: TranscriptSegment[];
  expectedAttendees: string[];
  busy: boolean;
  onConfirm: (speakers: SpeakerIdentification[]) => void;
}

/**
 * The one human checkpoint in the pipeline.
 *
 * A name attached to the wrong resolution is the worst thing this app can
 * produce -- wrong with confidence, in a document of record. Ten seconds of
 * checking removes that whole class of error, so it is not skippable.
 */
export default function Speakers({
  speakers,
  transcript,
  expectedAttendees,
  busy,
  onConfirm,
}: Props) {
  const [edited, setEdited] = useState<SpeakerIdentification[]>(speakers);

  const update = (speakerId: string, name: string) => {
    setEdited((prev) =>
      prev.map((s) => (s.speakerId === speakerId ? { ...s, name } : s)),
    );
  };

  const unnamed = edited.filter((s) => !s.name?.trim()).length;

  return (
    <>
      <div>
        <p className="eyebrow">Step 1 of 2 · before drafting</p>
        <h1>Who was speaking?</h1>
      </div>
      <p className="sub">
        Matched from the introductions at the start. Correct anything wrong —
        these names go straight into the minutes.
      </p>

      {unnamed > 0 && (
        <div className="banner warn">
          {unnamed === 1 ? '1 speaker was' : `${unnamed} speakers were`} never
          identified. Leave blank if you do not know — they will appear as “an
          unidentified attendee” and be flagged, which is safer than a guess.
        </div>
      )}

      <div className="stack">
        {edited.map((speaker) => (
          <div className="speaker-card" key={speaker.speakerId}>
            <div className="speaker-head">
              <span className="speaker-id">{speaker.speakerId}</span>
              <span className={`badge ${speaker.confidence}`}>
                {speaker.name ? speaker.confidence : 'not identified'}
              </span>
            </div>

            {speaker.evidence ? (
              <p className="evidence">
                {speaker.evidenceTime != null && (
                  <span className="t">{formatTime(speaker.evidenceTime)}</span>
                )}
                “{speaker.evidence}”
              </p>
            ) : (
              <p className="hint">
                Never said their own name and was never addressed by name.
              </p>
            )}

            <input
              value={speaker.name ?? ''}
              onChange={(e) => update(speaker.speakerId, e.target.value)}
              placeholder="Name"
              list={expectedAttendees.length ? 'expected-attendees' : undefined}
              autoComplete="off"
              autoCapitalize="words"
              aria-label={`Name for ${speaker.speakerId}`}
            />

            <p className="hint">
              {speaker.segmentCount} contribution
              {speaker.segmentCount === 1 ? '' : 's'}
              {(() => {
                const sample = transcript.find((s) => s.speaker === speaker.speakerId);
                return sample ? ` · first heard: “${truncate(sample.text, 62)}”` : '';
              })()}
            </p>
          </div>
        ))}
      </div>

      {expectedAttendees.length > 0 && (
        <datalist id="expected-attendees">
          {expectedAttendees.map((name) => (
            <option value={name} key={name} />
          ))}
        </datalist>
      )}

      <button className="btn-primary" onClick={() => onConfirm(edited)} disabled={busy}>
        {busy ? 'Drafting…' : 'Draft the minutes'}
      </button>
    </>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
