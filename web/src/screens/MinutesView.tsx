import { useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Evidence, MinuteItem, Minutes, Motion, TranscriptSegment } from '../types';

interface Props {
  meetingId: string;
  audioAvailable: boolean;
  minutes: Minutes;
  markdown: string;
  transcript: TranscriptSegment[];
  onRetranscribe: () => void;
  onNew: () => void;
}

export default function MinutesView({
  meetingId,
  audioAvailable,
  minutes,
  markdown,
  transcript,
  onRetranscribe,
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
      /* dismissed */
    }
  };

  return (
    <>
      <div>
        <p className="eyebrow">Draft — not a record until approved</p>
        <h1>{minutes.title}</h1>
      </div>

      {minutes.flaggedForReview.length > 0 && (
        <details className="review">
          <summary>
            <span className="review-count">{minutes.flaggedForReview.length}</span>
            {minutes.flaggedForReview.length === 1
              ? 'point to verify before sign-off'
              : 'points to verify before sign-off'}
            <span className="review-chevron">▼</span>
          </summary>
          <ul>
            {minutes.flaggedForReview.map((flag, i) => (
              <li key={i}>{flag}</li>
            ))}
          </ul>
        </details>
      )}

      <article className="sheet">
        <header className="sheet-head">
          <div className="sheet-body-name">{minutes.bodyName}</div>
          <h2 className="sheet-title">Minutes of the {minutes.title}</h2>
          <dl className="sheet-facts">
            <dt>Date</dt>
            <dd>{formatDate(minutes.date)}</dd>
            {minutes.startTime && (
              <>
                <dt>Time</dt>
                <dd>
                  {minutes.startTime}
                  {minutes.endTime ? ` – ${minutes.endTime}` : ''}
                </dd>
              </>
            )}
            <dt>Place</dt>
            <dd>{minutes.location || 'Not recorded'}</dd>
            {minutes.chair && (
              <>
                <dt>Chair</dt>
                <dd>{minutes.chair}</dd>
              </>
            )}
            {minutes.secretary && (
              <>
                <dt>Secretary</dt>
                <dd>{minutes.secretary}</dd>
              </>
            )}
          </dl>
        </header>

        <div className="roll">
          <div>
            <span className="roll-label">Present</span>
            {minutes.present.length ? minutes.present.join(', ') : 'Not recorded'}
          </div>
          {minutes.inAttendance?.length > 0 && (
            <div>
              <span className="roll-label">In attendance</span>
              {minutes.inAttendance.join(', ')}
            </div>
          )}
          {minutes.apologies?.length > 0 && (
            <div>
              <span className="roll-label">Apologies</span>
              {minutes.apologies.join(', ')}
            </div>
          )}
        </div>

        {minutes.items.map((item) => (
          <Item
            item={item}
            meetingId={meetingId}
            playable={audioAvailable}
            key={item.number}
          />
        ))}

        {minutes.nextMeeting && (
          <section className="item">
            <h3 className="item-heading">
              <span className="item-number">·</span>
              <span>Date of next meeting</span>
            </h3>
            <p>{minutes.nextMeeting}</p>
          </section>
        )}

        <p className="colophon">
          Drafted automatically from the meeting recording. Quotations are
          verbatim in the language spoken; the body of these minutes is a
          translation. Not a signed record until approved.
        </p>
      </article>

      <div className="stack">
        <button className="btn-primary" onClick={share}>
          {copied ? 'Copied' : 'Share minutes'}
        </button>
        <a href={api.docxUrl(meetingId)} download>
          <button className="btn-secondary">Download as Word (.docx)</button>
        </a>
        <a href={api.minutesUrl(meetingId)} download>
          <button className="btn-ghost">Download as Markdown</button>
        </a>
        <button className="btn-ghost" onClick={() => setShowTranscript((v) => !v)}>
          {showTranscript ? 'Hide' : 'Show'} verbatim transcript ({transcript.length}{' '}
          lines)
        </button>
        {audioAvailable && (
          <button className="btn-ghost" onClick={onRetranscribe}>
            Re-process from the recording
          </button>
        )}
        <button className="btn-ghost" onClick={onNew}>
          New meeting
        </button>
      </div>

      {showTranscript && (
        <div className="card">
          <p className="hint">
            Verbatim, in the language spoken. Cantonese is written as spoken
            (口語) rather than converted to 書面語, so it stays usable as evidence
            of what was actually said.
          </p>
          <div className="stack" style={{ gap: 9, marginTop: 6 }}>
            {transcript.map((segment, i) => (
              <p className="transcript-line" key={i}>
                <Quote
                  evidence={{ time: segment.start, quote: '' }}
                  meetingId={meetingId}
                  playable={audioAvailable}
                  timeOnly
                />
                <span className="who">{segment.speaker}</span>
                {segment.text}
              </p>
            ))}
          </div>
          <a href={api.transcriptUrl(meetingId)} download style={{ marginTop: 12 }}>
            <button className="btn-secondary">Download transcript</button>
          </a>
        </div>
      )}

      <p className="footer-note">
        {audioAvailable
          ? 'The recording is retained so quotes can be played back, and is deleted automatically on the bucket’s retention schedule.'
          : 'The audio recording was deleted once these minutes were drafted.'}
      </p>
    </>
  );
}

function Item({
  item,
  meetingId,
  playable,
}: {
  item: MinuteItem;
  meetingId: string;
  playable: boolean;
}) {
  const sources = [
    ...(item.evidence ?? []),
    ...(item.actions ?? []).map((a) => a.evidence).filter((e): e is Evidence => !!e),
  ];

  return (
    <section className="item">
      <h3 className="item-heading">
        <span className="item-number">{item.number}.</span>
        <span>{item.heading}</span>
      </h3>

      {item.discussion
        .split('\n')
        .filter(Boolean)
        .map((para, i) => (
          <p key={i}>{para}</p>
        ))}

      {item.motions?.map((motion, i) => (
        <MotionBlock motion={motion} meetingId={meetingId} playable={playable} key={i} />
      ))}

      {item.resolutions?.map((resolution, i) => (
        <div className="resolution" key={i}>
          <span className="kicker">RESOLVED THAT</span>
          {resolution.replace(/^\s*resolved\s+that\s+/i, '')}
        </div>
      ))}

      {item.actions?.length > 0 && (
        <table className="actions-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Owner</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {item.actions.map((action, i) => (
              <tr key={i}>
                <td>
                  {action.action}
                  {action.confidence === 'low' && (
                    <span className="verify-tag">VERIFY</span>
                  )}
                </td>
                <td>{action.owner}</td>
                <td>{action.dueDate ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sources.length > 0 && (
        <details className="sources">
          <summary>What was actually said ({sources.length})</summary>
          <div className="sources-list">
            {sources.map((e, i) => (
              <Quote evidence={e} meetingId={meetingId} playable={playable} key={i} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function MotionBlock({
  motion,
  meetingId,
  playable,
}: {
  motion: Motion;
  meetingId: string;
  playable: boolean;
}) {
  const tone = motion.outcome.startsWith('carried')
    ? 'carried'
    : motion.outcome === 'defeated'
      ? 'defeated'
      : 'other';

  const votes = [
    motion.votesFor != null ? `${motion.votesFor} for` : null,
    motion.votesAgainst != null ? `${motion.votesAgainst} against` : null,
    motion.abstentions != null ? `${motion.abstentions} abstaining` : null,
  ].filter(Boolean);

  return (
    <div className="motion">
      <span className="kicker">MOTION</span>
      {motion.text}
      {(motion.proposedBy || motion.secondedBy) && (
        <div className="motion-meta">
          {motion.proposedBy && `Proposed by ${motion.proposedBy}`}
          {motion.proposedBy && motion.secondedBy && ', '}
          {motion.secondedBy && `seconded by ${motion.secondedBy}`}
        </div>
      )}
      {/* Verdict and tally are separate: a pill long enough to wrap onto two
          lines stops reading as a pill. */}
      <div className="outcome-row">
        <span className={`outcome ${tone}`}>{motion.outcome}</span>
        {votes.length > 0 && <span className="tally">{votes.join(' · ')}</span>}
      </div>
      {motion.evidence && (
        <div style={{ marginTop: 9 }}>
          <Quote evidence={motion.evidence} meetingId={meetingId} playable={playable} />
        </div>
      )}
    </div>
  );
}

/**
 * A quote is the check on a claim. The minutes are in English but the meeting
 * was not, so the English is a translation nobody can verify from the page --
 * unless the original words, and now the original audio, sit underneath it.
 */
function Quote({
  evidence,
  meetingId,
  playable,
  timeOnly = false,
}: {
  evidence: Evidence;
  meetingId: string;
  playable: boolean;
  /** Render just the play control, for the transcript where the text follows. */
  timeOnly?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'gone'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      return;
    }
    setState('loading');
    try {
      const audio = new Audio(api.clipUrl(meetingId, evidence.time));
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('gone');
      await audio.play();
      setState('playing');
    } catch {
      setState('gone');
    }
  };

  const control =
    playable && state !== 'gone' ? (
      <button
        className="clip-play"
        onClick={play}
        aria-label={`Play the recording at ${formatTime(evidence.time)}`}
      >
        {state === 'playing' ? '❚❚' : state === 'loading' ? '…' : '▶'}
        <span className="t">{formatTime(evidence.time)}</span>
      </button>
    ) : (
      <span className="t">{formatTime(evidence.time)}</span>
    );

  if (timeOnly) return control;

  return (
    <p className="quote">
      {control}
      “{evidence.quote}”
    </p>
  );
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
