import { useEffect, useRef } from 'react';
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

  // Follow the transcript unless the user has scrolled up to read something --
  // yanking them back to the bottom mid-sentence is infuriating.
  useEffect(() => {
    const el = feedRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [liveLines]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    pinnedToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // Nothing above the noise floor for a while means the mic is muted, covered,
  // or pointed at nobody. Worth saying out loud before the meeting is over.
  const quiet = elapsed > 25 && level < 0.02;

  return (
    <div className="recording">
      <div className="timer">{formatElapsed(elapsed)}</div>
      <div className="timer-label">
        {meta.title} · recording
      </div>

      <div className="meter" aria-hidden>
        <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <div className={`meter-note${quiet ? ' bad' : ''}`}>
        {quiet
          ? 'Hearing almost nothing — check the mic is not covered'
          : deviceLabel}
      </div>

      <div className="status-strip">
        <span className={`pill ${connected ? 'live' : 'offline'}`}>
          {connected ? '● Uploading' : '● Reconnecting'}
        </span>
        {pendingBytes > 64_000 && (
          <span className="pill offline">
            {formatBacklog(pendingBytes)} buffered
          </span>
        )}
        {!wakeLockHeld && (
          <span className="pill offline">Screen may sleep</span>
        )}
      </div>

      {!wakeLockHeld && (
        <div className="banner warn">
          {wakeLockSupported
            ? 'Could not keep the screen awake.'
            : 'This browser cannot keep the screen awake.'}{' '}
          <strong>
            Turn off auto-lock in Settings, or keep tapping the screen.
          </strong>{' '}
          If the phone locks, recording stops.
        </div>
      )}

      {!connected && (
        <div className="banner warn">
          Lost the connection. Audio is being buffered and will upload when it
          comes back — keep recording.
        </div>
      )}

      <div className="live-feed" ref={feedRef} onScroll={onScroll}>
        {liveLines.length === 0 ? (
          <div className="empty">
            Live transcript appears here every 20 seconds.
            <br />
            <br />
            It is rough on purpose — use it to check everyone is being picked up.
            The accurate transcript is produced from the full recording when you
            stop.
          </div>
        ) : (
          liveLines.map((line, i) => (
            <div className="live-line" key={`${line.start}-${i}`}>
              <span className="live-time">{formatElapsed(line.start)}</span>
              {line.text}
            </div>
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
