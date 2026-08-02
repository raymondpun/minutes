import { useEffect, useMemo, useRef, useState } from 'react';
import type { DigestBlock, LiveLine, MeetingMeta } from '../types';

export type Phase = 'roll_call' | 'recording' | 'paused';

interface Props {
  meta: MeetingMeta;
  phase: Phase;
  elapsed: number;
  level: number;
  connected: boolean;
  liveLines: LiveLine[];
  digest: DigestBlock[];
  namesHeard: string[];
  pendingBytes: number;
  deviceLabel: string;
  wakeLockHeld: boolean;
  wakeLockSupported: boolean;
  busy: boolean;
  onRollCallDone: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const BARS = 32;

export default function Recording({
  meta,
  phase,
  elapsed,
  level,
  connected,
  liveLines,
  digest,
  namesHeard,
  pendingBytes,
  deviceLabel,
  wakeLockHeld,
  wakeLockSupported,
  busy,
  onRollCallDone,
  onPause,
  onResume,
  onStop,
}: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [history, setHistory] = useState<number[]>(() => new Array(BARS).fill(0));
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
  const [query, setQuery] = useState('');
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    setHistory((prev) => [...prev.slice(1), phase === 'paused' ? 0 : level]);
  }, [level, phase]);

  const searching = query.trim().length > 0;

  const visibleLines = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return liveLines;
    return liveLines.filter((l) => l.text.toLowerCase().includes(q));
  }, [liveLines, query]);

  // The level meter updates ten times a second, and each update re-renders this
  // component. Reconciling a two hour transcript at that rate is sustained
  // main-thread work on the same thread feeding the audio worklet. Only the
  // recent tail is mounted; a search still looks at every line, and the whole
  // transcript is safe on the server either way.
  const TAIL = 250;
  const truncated = !searching && visibleLines.length > TAIL;
  const rendered = truncated ? visibleLines.slice(-TAIL) : visibleLines;

  const lineElements = useMemo(
    () =>
      rendered.map((line, i) => (
        <p className="live-line" key={`${line.start}-${i}`}>
          <span className="live-time">{formatElapsed(line.start)}</span>
          {searching ? highlight(line.text, query.trim()) : line.text}
        </p>
      )),
    [rendered, searching, query],
  );

  // Follow along, but never while the chair is reading back through it. Being
  // yanked to the bottom mid-sentence is exactly when this feature fails.
  useEffect(() => {
    const el = feedRef.current;
    if (el && pinnedToBottom.current && !searching) el.scrollTop = el.scrollHeight;
  }, [visibleLines, digest, searching, tab]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinnedToBottom.current = bottom;
    setAtBottom(bottom);
  };

  const backToLive = () => {
    setQuery('');
    pinnedToBottom.current = true;
    requestAnimationFrame(() => {
      const el = feedRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    });
  };

  const quiet = phase !== 'paused' && elapsed > 25 && history.every((v) => v < 0.02);
  const rewound = searching || !atBottom;

  /* ------------------------------------------------------------ roll call - */

  if (phase === 'roll_call') {
    return (
      <div className="recording">
        <div>
          <p className="eyebrow">Step 1 · roll call · recording has started</p>
          <h1>Ask everyone to say their name</h1>
        </div>
        <p className="sub">
          Go round the table. One sentence each — “我係 Raymond, Finance” is
          plenty. This is how the minutes know who said what, and anyone who
          skips it will appear as an unidentified attendee.
        </p>

        <Meter history={history} level={level} quiet={quiet} note={deviceLabel} />

        <div className="live-feed" ref={feedRef} onScroll={onScroll}>
          {liveLines.length === 0 ? (
            <p className="feed-empty">
              Listening. Introductions will appear here within about twenty
              seconds — use that to check the far end of the table is being
              picked up before the meeting starts.
            </p>
          ) : (
            liveLines.map((line, i) => (
              <p className="live-line" key={`${line.start}-${i}`}>
                <span className="live-time">{formatElapsed(line.start)}</span>
                {line.text}
              </p>
            ))
          )}
        </div>

        {namesHeard.length > 0 && (
          <div className="rollcall-voices">
            {namesHeard.map((name, i) => (
              <div className="voice-chip" key={`${name}-${i}`}>
                <span className="n">{i + 1}</span>
                {name}
              </div>
            ))}
          </div>
        )}

        <button className="btn-ghost" onClick={onRollCallDone} disabled={busy}>
          Skip ahead — we’re done introducing
        </button>
        <p className="footer-note">
          This moves on by itself once the introductions stop, so you can leave
          the phone alone. Recording is already running and nothing said now is
          lost — anyone arriving late can still say their name aloud.
        </p>
      </div>
    );
  }

  /* -------------------------------------------------------------- paused -- */

  if (phase === 'paused') {
    return (
      <div className="recording">
        <div className="timer-block">
          <div className="timer">{formatElapsed(elapsed)}</div>
          <div className="timer-label">{meta.title}</div>
        </div>

        <div className="paused-state">
          <span className="paused-mark">Paused</span>
          <p className="sub" style={{ textAlign: 'center' }}>
            The microphone is off and nothing is being recorded or transcribed.
            The room can see the phone is no longer listening.
          </p>
          <p className="hint" style={{ textAlign: 'center' }}>
            {formatElapsed(elapsed)} captured so far. Time spent paused does not
            appear in the recording.
          </p>
        </div>

        <div className="controls">
          <button className="btn-primary" onClick={onResume} disabled={busy}>
            {busy ? 'Resuming…' : 'Resume'}
          </button>
        </div>
        <button className="btn-ghost" onClick={onStop} disabled={busy}>
          End meeting & draft minutes
        </button>
      </div>
    );
  }

  /* ----------------------------------------------------------- recording -- */

  return (
    <div className="recording">
      <div className="timer-block">
        <div className="timer">{formatElapsed(elapsed)}</div>
        <div className="timer-label">
          <span className="rec-dot" aria-hidden />
          {meta.title}
        </div>
      </div>

      <Meter history={history} level={level} quiet={quiet} note={deviceLabel} />

      <div className="status-strip">
        <span className={`pill ${connected ? 'good' : 'warn'}`}>
          {connected ? 'Uploading' : 'Reconnecting'}
        </span>
        {pendingBytes > 64_000 && (
          <span className="pill warn">{formatBacklog(pendingBytes)} buffered</span>
        )}
        {!wakeLockHeld && <span className="pill warn">Screen may sleep</span>}
      </div>

      {!wakeLockHeld && (
        <div className="banner warn">
          {wakeLockSupported
            ? 'Could not keep the screen awake.'
            : 'This browser cannot keep the screen awake.'}{' '}
          Turn off auto-lock — <strong>if the phone locks, recording stops.</strong>
        </div>
      )}

      {!connected && (
        <div className="banner warn">
          Connection lost. Audio is buffering and will upload when it returns —
          keep recording.
        </div>
      )}

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'summary'}
          className={tab === 'summary' ? 'tab on' : 'tab'}
          onClick={() => setTab('summary')}
        >
          Summary{digest.length > 0 && ` (${digest.length})`}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'transcript'}
          className={tab === 'transcript' ? 'tab on' : 'tab'}
          onClick={() => setTab('transcript')}
        >
          Transcript
        </button>
      </div>

      {tab === 'transcript' && liveLines.length > 2 && (
        <div className="feed-search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what has been said…"
            aria-label="Search the live transcript"
          />
          {searching && (
            <span className="feed-count">
              {visibleLines.length} {visibleLines.length === 1 ? 'match' : 'matches'}
            </span>
          )}
        </div>
      )}

      <div className="feed-wrap">
        <div className="live-feed" ref={feedRef} onScroll={onScroll}>
          {tab === 'summary' ? (
            digest.length === 0 ? (
              <p className="feed-empty">
                A summary of each topic appears here every few minutes, so you can
                look back at what was covered without reading the whole transcript.
              </p>
            ) : (
              digest.map((block, i) => (
                <Block block={block} key={`${block.start}-${i}`} />
              ))
            )
          ) : visibleLines.length === 0 ? (
            <p className="feed-empty">
              {searching
                ? `Nothing matching “${query.trim()}” yet.`
                : 'The raw transcript appears here as the meeting runs.'}
            </p>
          ) : (
            <>
              {truncated && (
                <p className="feed-truncated">
                  Showing the last {TAIL} lines. Search to reach anything earlier.
                </p>
              )}
              {lineElements}
            </>
          )}
        </div>

        {rewound && (tab === 'summary' ? digest.length > 0 : liveLines.length > 0) && (
          <button className="back-to-live" onClick={backToLive}>
            ↓ Back to live
          </button>
        )}
      </div>

      <div className="controls">
        <button className="btn-secondary" onClick={onPause} disabled={busy}>
          Pause
        </button>
        <button className="btn-primary" onClick={onStop} disabled={busy}>
          {busy ? 'Finishing…' : 'End meeting'}
        </button>
      </div>
    </div>
  );
}

function Meter({
  history,
  level,
  quiet,
  note,
}: {
  history: number[];
  level: number;
  quiet: boolean;
  note: string;
}) {
  return (
    <div>
      <div className="vu" role="img" aria-label={`Input level ${Math.round(level * 100)}%`}>
        {history.map((value, i) => (
          <div
            key={i}
            className={`vu-bar${value > 0.55 ? ' hot' : value > 0.03 ? ' on' : ''}`}
            style={{ height: `${Math.max(4, Math.round(value * 48))}px` }}
          />
        ))}
      </div>
      <div className={`meter-note${quiet ? ' bad' : ''}`}>
        {quiet ? 'Hearing almost nothing — check the mic is not covered' : note}
      </div>
    </div>
  );
}

function Block({ block }: { block: DigestBlock }) {
  return (
    <section className="digest-block">
      <header className="digest-head">
        <span className="digest-time">
          {formatElapsed(block.start)}–{formatElapsed(block.end)}
        </span>
        <h3 className="digest-heading">
          {block.continuesPrevious && <span className="digest-cont">↳ </span>}
          {block.heading}
        </h3>
      </header>
      <ul className="digest-bullets">
        {block.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
      {block.decisions.length > 0 && (
        <div className="digest-decisions">
          <span className="digest-decisions-label">Sounded decided</span>
          <ul>
            {block.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Mark the matched span so a hit is findable inside a long block of text. */
function highlight(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

function formatElapsed(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatBacklog(bytes: number): string {
  // 16 kHz mono 16-bit = 32 kB per second.
  const seconds = Math.round(bytes / 32_000);
  return seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}
