import { useState } from 'react';
import { api } from '../lib/api';
import type { Evidence, Minutes, TranscriptSegment } from '../types';

interface Props {
  meetingId: string;
  minutes: Minutes;
  markdown: string;
  transcript: TranscriptSegment[];
  onNew: () => void;
}

export default function MinutesView({
  meetingId,
  minutes,
  markdown,
  transcript,
  onNew,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const share = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({
        title: `${minutes.title} — ${minutes.date}`,
        text: markdown,
      });
    } catch {
      /* user dismissed the sheet */
    }
  };

  return (
    <div>
      <h1>Minutes</h1>
      <p className="sub">Draft — not a record until approved.</p>

      {minutes.flaggedForReview.length > 0 && (
        <div className="review-box">
          <h2>⚠️ Check before you send this</h2>
          <ul>
            {minutes.flaggedForReview.map((flag, i) => (
              <li key={i}>{flag}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="minutes">
        <h1>{minutes.bodyName}</h1>
        <h2>Minutes of the {minutes.title}</h2>

        <p>
          <strong>Date:</strong> {formatDate(minutes.date)}
          <br />
          {minutes.startTime && (
            <>
              <strong>Time:</strong> {minutes.startTime}
              {minutes.endTime ? ` – ${minutes.endTime}` : ''}
              <br />
            </>
          )}
          <strong>Location:</strong> {minutes.location || 'Not recorded'}
          {minutes.chair && (
            <>
              <br />
              <strong>Chair:</strong> {minutes.chair}
            </>
          )}
        </p>

        <p>
          <strong>Present:</strong>{' '}
          {minutes.present.length ? minutes.present.join(', ') : 'Not recorded'}
        </p>
        {minutes.inAttendance?.length > 0 && (
          <p>
            <strong>In attendance:</strong> {minutes.inAttendance.join(', ')}
          </p>
        )}
        {minutes.apologies?.length > 0 && (
          <p>
            <strong>Apologies for absence:</strong> {minutes.apologies.join(', ')}
          </p>
        )}

        <hr />

        {minutes.items.map((item) => (
          <section key={item.number}>
            <h3>
              {item.number}. {item.heading}
            </h3>

            {item.discussion && <p>{item.discussion}</p>}

            {item.motions?.map((motion, i) => (
              <blockquote key={i}>
                <strong>Motion:</strong> {motion.text}
                <br />
                {(motion.proposedBy || motion.secondedBy) && (
                  <em>
                    {motion.proposedBy && `Proposed by ${motion.proposedBy}`}
                    {motion.proposedBy && motion.secondedBy && ', '}
                    {motion.secondedBy && `seconded by ${motion.secondedBy}`}.
                    <br />
                  </em>
                )}
                <strong>Outcome:</strong> {motion.outcome}
                {formatVotes(motion.votesFor, motion.votesAgainst, motion.abstentions)}
                {motion.confidence === 'low' && <strong> [TO VERIFY]</strong>}
                {motion.evidence && <Quote evidence={motion.evidence} />}
              </blockquote>
            ))}

            {item.resolutions?.map((resolution, i) => (
              <p key={i}>
                <strong>RESOLVED THAT</strong>{' '}
                {resolution.replace(/^\s*resolved\s+that\s+/i, '')}
              </p>
            ))}

            {item.actions?.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Owner</th>
                    <th>By when</th>
                  </tr>
                </thead>
                <tbody>
                  {item.actions.map((action, i) => (
                    <tr key={i}>
                      <td>
                        {action.action}
                        {action.confidence === 'low' && <strong> [TO VERIFY]</strong>}
                      </td>
                      <td>{action.owner}</td>
                      <td>{action.dueDate ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {collectEvidence(item).length > 0 && (
              <details>
                <summary>Source — what was actually said</summary>
                {collectEvidence(item).map((e, i) => (
                  <Quote evidence={e} key={i} />
                ))}
              </details>
            )}
          </section>
        ))}

        {minutes.nextMeeting && (
          <>
            <h3>Date of next meeting</h3>
            <p>{minutes.nextMeeting}</p>
          </>
        )}
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <button className="btn-primary" onClick={share}>
          {copied ? 'Copied' : 'Share / copy minutes'}
        </button>
        <a href={api.minutesUrl(meetingId)} download>
          <button className="btn-secondary" style={{ width: '100%' }}>
            Download as Markdown
          </button>
        </a>
        <button
          className="btn-ghost"
          onClick={() => setShowTranscript((v) => !v)}
        >
          {showTranscript ? 'Hide' : 'Show'} verbatim transcript (
          {transcript.length} lines)
        </button>
        <button className="btn-ghost" onClick={onNew}>
          New meeting
        </button>
      </div>

      {showTranscript && (
        <div className="card" style={{ marginTop: 14 }}>
          <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
            Verbatim, in the language spoken. Cantonese is written as spoken
            (口語) rather than converted to 書面語, so it stays usable as evidence
            of what was actually said.
          </p>
          {transcript.map((segment, i) => (
            <p key={i} style={{ fontSize: 14, marginBottom: 8 }}>
              <span className="live-time">{formatTime(segment.start)}</span>
              <strong>{segment.speaker}:</strong> {segment.text}
            </p>
          ))}
          <a href={api.transcriptUrl(meetingId)} download>
            <button className="btn-secondary" style={{ width: '100%' }}>
              Download transcript
            </button>
          </a>
        </div>
      )}

      <p className="footer-note">
        The audio recording was deleted once these minutes were drafted.
      </p>
    </div>
  );
}

function Quote({ evidence }: { evidence: Evidence }) {
  return (
    <p style={{ margin: '6px 0 0' }}>
      <code>{formatTime(evidence.time)}</code> “{evidence.quote}”
    </p>
  );
}

function collectEvidence(item: {
  evidence?: Evidence[];
  actions?: Array<{ evidence: Evidence | null }>;
}): Evidence[] {
  return [
    ...(item.evidence ?? []),
    ...(item.actions ?? []).map((a) => a.evidence).filter((e): e is Evidence => !!e),
  ];
}

function formatVotes(
  For: number | null,
  against: number | null,
  abstentions: number | null,
): string {
  const parts = [
    For != null ? `${For} for` : null,
    against != null ? `${against} against` : null,
    abstentions != null ? `${abstentions} abstaining` : null,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
