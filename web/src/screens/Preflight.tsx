import { useEffect, useState } from 'react';
import { api } from '../lib/api';
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
 * Two jobs. The consent announcement -- you are about to record colleagues, and
 * they are entitled to know. And catching the setup mistakes that would
 * otherwise only surface after the meeting is over and unrepeatable.
 */
export default function Preflight({ meta, starting, error, onStart, onBack }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [announced, setAnnounced] = useState(false);
  const [retainDays, setRetainDays] = useState<number | null>(null);

  // The announcement has to describe what actually happens to the recording,
  // which depends on how this deployment is configured. Saying "deleted
  // afterwards" while a bucket quietly keeps it for a month would make the
  // consent worthless.
  useEffect(() => {
    void api
      .health()
      .then((h) => setRetainDays(h.retainAudioDays ?? 0))
      .catch(() => setRetainDays(null));
  }, []);

  useEffect(() => {
    // Labels only populate after permission has been granted once, so an
    // empty-looking list on first run is expected rather than broken.
    void listMicrophones().then(setDevices);
  }, []);

  const externalMic = devices.find(
    (d) => d.label && !/default|internal|built-?in|iphone|android/i.test(d.label),
  );

  return (
    <>
      <div>
        <p className="eyebrow">
          {formatDate(meta.date)}
          {meta.location ? ` · ${meta.location}` : ''}
        </p>
        <h1>{meta.title || 'Meeting'}</h1>
      </div>

      <div className="card">
        <div className="field">
          <label>Say this before you start</label>
          <p style={{ fontSize: 17, lineHeight: 1.6, fontFamily: 'var(--font-doc)' }}>
            “I’m recording this meeting to draft the minutes.{' '}
            {retainDays === null
              ? 'The recording is kept only as long as it is needed.'
              : retainDays > 0
                ? `The recording is kept for ${retainDays} days so we can check anything that’s disputed, then deleted automatically.`
                : 'The recording is deleted as soon as the minutes are written.'}{' '}
            Any objections?”
          </p>
          <p className="hint">
            Recording people without telling them is a bad idea generally, and
            under the PDPO they are entitled to know what is being collected and
            why. Ten seconds now avoids a much worse conversation later.
          </p>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={announced}
            onChange={(e) => setAnnounced(e.target.checked)}
          />
          I have told everyone in the room
        </label>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="mic">Microphone</label>
          <select id="mic" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
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
              : 'Phone flat in the middle of the table, screen up, away from laptops and aircon vents. Beyond about two metres speech becomes mush, and no amount of AI recovers audio that was never captured.'}
          </p>
        </div>
      </div>

      {isIOS() && (
        <div className="banner warn">
          <strong>iPhone:</strong> if the screen locks, recording stops. The app
          holds a wake lock where Safari supports it, but before a long meeting
          set <strong>Settings → Display &amp; Brightness → Auto-Lock → Never</strong>,
          and do not switch apps.
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
          {starting
            ? 'Starting…'
            : announced
              ? 'Start recording'
              : 'Confirm the announcement first'}
        </button>
        <button className="btn-ghost" onClick={onBack} disabled={starting}>
          Back
        </button>
      </div>
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
