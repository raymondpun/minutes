import { useEffect, useState } from 'react';
import { listMicrophones } from '../lib/recorder';
import { isIOS, ScreenLockGuard } from '../lib/wakeLock';
import type { MeetingMeta } from '../types';

interface Props {
  meta: MeetingMeta;
  starting: boolean;
  error: string | null;
  onStart: (deviceId?: string) => void;
  onBack: () => void;
}

/**
 * The screen between filling in the form and recording.
 *
 * Two jobs. First, the consent announcement -- you are about to record
 * colleagues, and they are entitled to know. Second, catching the setup
 * mistakes that would otherwise only reveal themselves after the meeting is
 * over and unrepeatable.
 */
export default function Preflight({ meta, starting, error, onStart, onBack }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [announced, setAnnounced] = useState(false);

  useEffect(() => {
    // Labels are only populated after permission has been granted once, so an
    // empty-looking list on first run is expected rather than broken.
    void listMicrophones().then(setDevices);
  }, []);

  const externalMic = devices.find(
    (d) => !/default|internal|built-?in|iphone|android/i.test(d.label) && d.label,
  );

  return (
    <div>
      <h1>{meta.title || 'Meeting'}</h1>
      <p className="sub">
        {formatDate(meta.date)}
        {meta.location ? ` · ${meta.location}` : ''}
      </p>

      <div className="card">
        <label>Say this before you start</label>
        <p style={{ fontSize: 17, lineHeight: 1.6, margin: '4px 0 10px' }}>
          “I’m recording this meeting to draft the minutes. The recording is
          deleted once the minutes are written. Any objections?”
        </p>
        <p className="hint">
          Recording people without telling them is a bad idea generally, and in
          Hong Kong the PDPO expects them to know what is being collected and
          why. Ten seconds now avoids a much worse conversation later.
        </p>
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            marginTop: 14,
            fontSize: 15,
            color: 'var(--text)',
          }}
        >
          <input
            type="checkbox"
            checked={announced}
            onChange={(e) => setAnnounced(e.target.checked)}
            style={{ width: 22, height: 22, margin: 0, flex: '0 0 auto' }}
          />
          I have told everyone in the room
        </label>
      </div>

      <div className="card">
        <label htmlFor="mic">Microphone</label>
        <select
          id="mic"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          <option value="">Default microphone</option>
          {devices.map((d) => (
            <option value={d.deviceId} key={d.deviceId}>
              {d.label || 'Microphone'}
            </option>
          ))}
        </select>
        <p className="hint">
          {externalMic
            ? `An external mic is available (${externalMic.label}). Use it — it will pick up the far end of the table far better than the phone.`
            : 'Put the phone flat in the middle of the table, screen up, away from laptops and aircon vents. Anything more than about two metres away will be hard to hear, and no amount of AI fixes audio that was never captured.'}
        </p>
      </div>

      {isIOS() && (
        <div className="banner warn">
          <strong>iPhone:</strong> if the screen locks, recording stops. The app
          will try to prevent that, but set{' '}
          <strong>Settings → Display &amp; Brightness → Auto-Lock → Never</strong>{' '}
          before a long meeting, and do not switch to another app.
          {!ScreenLockGuard.supported && ' This iOS version cannot hold a wake lock at all.'}
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <div className="stack">
        <button
          className="btn-primary"
          onClick={() => onStart(deviceId || undefined)}
          disabled={starting || !announced}
        >
          {starting ? 'Starting…' : announced ? 'Start recording' : 'Confirm the announcement first'}
        </button>
        <button className="btn-ghost" onClick={onBack} disabled={starting}>
          Back
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
