import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CreateMeetingInput } from './lib/api';
import { startRecorder, type RecorderHandle } from './lib/recorder';
import { Uplink } from './lib/uplink';
import { ScreenLockGuard } from './lib/wakeLock';
import Setup from './screens/Setup';
import Preflight from './screens/Preflight';
import Recording from './screens/Recording';
import Speakers from './screens/Speakers';
import MinutesView from './screens/MinutesView';
import type {
  LiveLine,
  MeetingMeta,
  MeetingSnapshot,
  SpeakerIdentification,
} from './types';

type View = 'home' | 'setup' | 'preflight' | 'recording' | 'review';

export default function App() {
  const [view, setView] = useState<View>('home');
  const [meetings, setMeetings] = useState<MeetingMeta[]>([]);
  const [meta, setMeta] = useState<MeetingMeta | null>(null);
  const [snapshot, setSnapshot] = useState<MeetingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live recording state.
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [connected, setConnected] = useState(false);
  const [liveLines, setLiveLines] = useState<LiveLine[]>([]);
  const [pendingBytes, setPendingBytes] = useState(0);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const [stopping, setStopping] = useState(false);

  const recorderRef = useRef<RecorderHandle | null>(null);
  const uplinkRef = useRef<Uplink | null>(null);
  const wakeLockRef = useRef<ScreenLockGuard | null>(null);
  const startedAtRef = useRef<number>(0);

  /* ------------------------------------------------------------- home --- */

  const refreshMeetings = useCallback(async () => {
    try {
      setMeetings(await api.listMeetings());
    } catch {
      /* offline; the list is not critical */
    }
  }, []);

  useEffect(() => {
    if (view === 'home') void refreshMeetings();
  }, [view, refreshMeetings]);

  /* -------------------------------------------------------- recording --- */

  const createMeeting = async (input: CreateMeetingInput) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createMeeting(input);
      setMeta(created);
      setView('preflight');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const beginRecording = async (deviceId?: string) => {
    if (!meta) return;
    setBusy(true);
    setError(null);

    try {
      // Ask for the mic before anything else. If this is going to fail -- no
      // permission, not a secure context -- it must fail here, while the
      // meeting has not started, not after everyone has been talking for
      // five minutes.
      const uplink = new Uplink(meta.id, {
        onLive: (line) => setLiveLines((prev) => [...prev, line]),
        onSecondsRecorded: (seconds) => setElapsed(seconds),
        onConnectionChange: setConnected,
      });

      const recorder = await startRecorder(
        {
          onAudio: (pcm) => {
            uplink.send(pcm);
            setPendingBytes(uplink.pendingBytes);
          },
          onLevel: setLevel,
          onError: (err) => setError(err.message),
        },
        deviceId,
      );

      uplink.connect();
      uplinkRef.current = uplink;
      recorderRef.current = recorder;
      setDeviceLabel(recorder.deviceLabel);

      const guard = new ScreenLockGuard();
      wakeLockRef.current = guard;
      setWakeLockHeld(await guard.acquire());

      await api.startMeeting(meta.id);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setLiveLines([]);
      setView('recording');
    } catch (err) {
      setError(micErrorMessage(err));
      await teardown();
    } finally {
      setBusy(false);
    }
  };

  // The server's byte count is the source of truth for elapsed time, but it
  // only updates when a chunk lands. Tick locally in between so the timer does
  // not look frozen if the connection drops.
  useEffect(() => {
    if (view !== 'recording') return;
    const id = window.setInterval(() => {
      setElapsed((prev) => {
        const wall = (Date.now() - startedAtRef.current) / 1000;
        return Math.max(prev, wall);
      });
      setPendingBytes(uplinkRef.current?.pendingBytes ?? 0);
    }, 1000);
    return () => window.clearInterval(id);
  }, [view]);

  // A meeting in progress must survive a stray back-swipe or tab close.
  useEffect(() => {
    if (view !== 'recording') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [view]);

  const teardown = async () => {
    await recorderRef.current?.stop().catch(() => {});
    recorderRef.current = null;
    await wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  };

  const stopRecording = async () => {
    if (!meta) return;
    setStopping(true);
    setError(null);
    try {
      // Stop the mic first so no new audio arrives, then let the backlog drain
      // before telling the server the meeting is over -- otherwise it starts
      // transcribing while the last minute is still in flight.
      await teardown();
      await uplinkRef.current?.drain();
      uplinkRef.current?.close();
      uplinkRef.current = null;

      await api.stopMeeting(meta.id);
      setView('review');
    } catch (err) {
      setError(message(err));
    } finally {
      setStopping(false);
    }
  };

  /* ----------------------------------------------------------- review --- */

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const next = await api.getMeeting(id);
      setSnapshot(next);
      setMeta(next.meta);
      return next;
    } catch (err) {
      setError(message(err));
      return null;
    }
  }, []);

  // Poll while the server is working. Transcribing an hour of audio takes a
  // few minutes, and the phone cannot hold a request open that long.
  useEffect(() => {
    if (view !== 'review' || !meta) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const next = await loadSnapshot(meta.id);
      const status = next?.meta.status;
      if (
        !cancelled &&
        status &&
        !['complete', 'failed', 'awaiting_speakers'].includes(status)
      ) {
        window.setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [view, meta?.id, loadSnapshot]);

  const confirmSpeakers = async (speakers: SpeakerIdentification[]) => {
    if (!meta) return;
    setBusy(true);
    try {
      await api.confirmSpeakers(meta.id, speakers);
      await loadSnapshot(meta.id);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const openMeeting = async (id: string) => {
    setError(null);
    const next = await loadSnapshot(id);
    if (next) setView('review');
  };

  const reset = () => {
    setMeta(null);
    setSnapshot(null);
    setLiveLines([]);
    setElapsed(0);
    setError(null);
    setView('home');
  };

  /* ------------------------------------------------------------ render --- */

  return (
    <div className="app">
      {view === 'home' && (
        <Home
          meetings={meetings}
          error={error}
          onNew={() => {
            setError(null);
            setView('setup');
          }}
          onOpen={openMeeting}
        />
      )}

      {view === 'setup' && (
        <Setup onStart={createMeeting} onCancel={reset} busy={busy} />
      )}

      {view === 'preflight' && meta && (
        <Preflight
          meta={meta}
          starting={busy}
          error={error}
          onStart={beginRecording}
          onBack={() => setView('setup')}
        />
      )}

      {view === 'recording' && meta && (
        <>
          {error && <div className="banner error">{error}</div>}
          <Recording
            meta={meta}
            elapsed={elapsed}
            level={level}
            connected={connected}
            liveLines={liveLines}
            pendingBytes={pendingBytes}
            deviceLabel={deviceLabel}
            wakeLockHeld={wakeLockHeld}
            wakeLockSupported={ScreenLockGuard.supported}
            stopping={stopping}
            onStop={stopRecording}
          />
        </>
      )}

      {view === 'review' && (
        <Review
          snapshot={snapshot}
          busy={busy}
          error={error}
          onConfirmSpeakers={confirmSpeakers}
          onNew={reset}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ subviews --- */

function Home({
  meetings,
  error,
  onNew,
  onOpen,
}: {
  meetings: MeetingMeta[];
  error: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <h1>Minutes</h1>
      <p className="sub">
        Records an in-person meeting and drafts the formal minutes from it.
      </p>

      {error && <div className="banner error">{error}</div>}

      <button className="btn-primary" onClick={onNew}>
        Start a meeting
      </button>

      {meetings.length > 0 && (
        <>
          <h2>Past meetings</h2>
          <div className="stack">
            {meetings.map((m) => (
              <button
                className="meeting-item"
                key={m.id}
                onClick={() => onOpen(m.id)}
              >
                <span>
                  {m.title}
                  <div className="meta">
                    {m.date}
                    {m.durationSeconds
                      ? ` · ${Math.round(m.durationSeconds / 60)} min`
                      : ''}
                  </div>
                </span>
                <span className={`badge ${statusTone(m.status)}`}>
                  {statusLabel(m.status)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="footer-note">
        Audio is processed by Gemini on Vertex AI in your own Google Cloud
        project, and deleted once the minutes are drafted.
      </p>
    </div>
  );
}

function Review({
  snapshot,
  busy,
  error,
  onConfirmSpeakers,
  onNew,
}: {
  snapshot: MeetingSnapshot | null;
  busy: boolean;
  error: string | null;
  onConfirmSpeakers: (speakers: SpeakerIdentification[]) => void;
  onNew: () => void;
}) {
  if (!snapshot) {
    return (
      <div className="center">
        <div className="spinner" />
        <p className="sub">Loading…</p>
      </div>
    );
  }

  const { meta, speakers, transcript, minutes, markdown } = snapshot;

  if (meta.status === 'failed') {
    return (
      <div>
        <h1>Something went wrong</h1>
        <div className="banner error">{meta.error ?? 'Unknown error'}</div>
        <p className="sub">
          {snapshot.audioAvailable
            ? 'The recording is still on the server, so nothing is lost — this can be retried.'
            : 'The recording is no longer available.'}
        </p>
        <button className="btn-ghost" onClick={onNew}>
          Back
        </button>
      </div>
    );
  }

  if (meta.status === 'awaiting_speakers') {
    return (
      <>
        {error && <div className="banner error">{error}</div>}
        <Speakers
          speakers={speakers}
          transcript={transcript}
          expectedAttendees={meta.expectedAttendees}
          busy={busy}
          onConfirm={onConfirmSpeakers}
        />
      </>
    );
  }

  if (meta.status === 'complete' && minutes && markdown) {
    return (
      <MinutesView
        meetingId={meta.id}
        minutes={minutes}
        markdown={markdown}
        transcript={transcript}
        onNew={onNew}
      />
    );
  }

  return (
    <div className="center">
      <div className="spinner" />
      <h1>{statusLabel(meta.status)}</h1>
      <p className="sub">{meta.progress ?? 'Working…'}</p>
      <p className="hint">
        {meta.durationSeconds
          ? `${Math.round(meta.durationSeconds / 60)} minutes of audio. `
          : ''}
        This takes a few minutes. You can lock the phone — it keeps running on
        the server.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- helpers --- */

function statusLabel(status: MeetingMeta['status']): string {
  switch (status) {
    case 'setup':
      return 'Not started';
    case 'recording':
      return 'Recording';
    case 'transcribing':
      return 'Transcribing';
    case 'identifying':
      return 'Identifying speakers';
    case 'awaiting_speakers':
      return 'Needs your review';
    case 'drafting':
      return 'Drafting minutes';
    case 'complete':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
}

function statusTone(status: MeetingMeta['status']): string {
  if (status === 'complete') return 'high';
  if (status === 'failed') return 'low';
  if (status === 'awaiting_speakers') return 'medium';
  return '';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * getUserMedia failures are cryptic and each one has a completely different
 * fix, so translate them into the thing the user actually has to go and do.
 */
function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') {
    return 'Microphone access was denied. Allow it in your browser settings for this site, then try again.';
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another app. Close it and try again.';
  }
  if (!window.isSecureContext) {
    return 'The microphone only works over HTTPS. Open this app on its https:// address, not an IP address.';
  }
  return message(err);
}
