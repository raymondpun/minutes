import { useEffect, useRef, useState } from 'react';
import type { LiveLine, MeetingMeta } from '../types';

interface Props {
  meta: MeetingMeta;
  elapsed: number;
  level: number;
  connected: boolean;
  liveLines: LiveLine[];
  pendingBytes: number;
  deviceLabel: string;
  wakeLockHeld: boolean;
  wakeLockSupported: boolean;
  stopping: boolean;
  onStop: () => void;
}

const BARS = 32;

export default function Recording({
  meta,
  elapsed,
  level,
  connected,
  liveLines,
  pendingBytes,
  deviceLabel,
  wakeLockHeld,
  wakeLockSupported,
  stopping,
  onStop,
}: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [history, setHistory] = useState<number[]>(() => new Array(BARS).fill(0));

  // A scrolling bar array, not a single fill. A flat bar at low level looks
  // identical to a broken one, and "is it hearing us?" is the only question
  // this screen exists to answer.
  useEffect(() => {
    setHistory((prev) => [...prev.slice(1), level]);
  }, [level]);

  useEffect(() => {
    const el = feedRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [liveLines]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const quiet = elapsed > 25 && history.every((v) => v < 0.02);

  return (
    <div className="recording">
      <div className="timer-block">
        <div className="timer">{formatElapsed(elapsed)}</div>
        <div className="timer-label">
          <span className="rec-dot" aria-hidden />
          {meta.title}
        </div>
      </div>

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
          {quiet ? 'Hearing almost nothing — check the mic is not covered' : deviceLabel}
        </div>
      </div>

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

      <div className="live-feed" ref={feedRef} onScroll={onScroll}>
        {liveLines.length === 0 ? (
          <p className="feed-empty">
            Live transcript appears here every 20 seconds. It is rough on purpose
            — use it to check everyone is being picked up.
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

      <button className="btn-primary" onClick={onStop} disabled={stopping}>
        {stopping ? 'Finishing…' : 'End meeting & draft minutes'}
      </button>
    </div>
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
