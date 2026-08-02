import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CreateMeetingInput } from './lib/api';
import { startRecorder, type RecorderHandle } from './lib/recorder';
import { Uplink } from './lib/uplink';
import { ScreenLockGuard } from './lib/wakeLock';
import Setup from './screens/Setup';
import Preflight from './screens/Preflight';
import Recording, { type Phase } from './screens/Recording';
import Speakers from './screens/Speakers';
import MinutesView from './screens/MinutesView';
import type {
  DigestBlock,
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
  const [digest, setDigest] = useState<DigestBlock[]>([]);
  const [phase, setPhase] = useState<Phase>('roll_call');
  const [namesHeard, setNamesHeard] = useState<string[]>([]);
  const [pendingBytes, setPendingBytes] = useState(0);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const [stopping, setStopping] = useState(false);

  const recorderRef = useRef<RecorderHandle | null>(null);
  const uplinkRef = useRef<Uplink | null>(null);
  const wakeLockRef = useRef<ScreenLockGuard | null>(null);
  const startedAtRef = useRef<number>(0);
  const deviceIdRef = useRef<string | undefined>(undefined);
  /** Recorded seconds at the moment of the last pause, so the timer freezes. */
  const recordedBeforePauseRef = useRef(0);

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
        onDigest: (block) => setDigest((prev) => [...prev, block]),
        // The server decides when the introductions have finished, so the chair
        // never has to press anything mid-roll-call.
        onRollCallEnded: (namesHeard) => {
          setNamesHeard(namesHeard);
          setPhase('recording');
        },
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

      deviceIdRef.current = deviceId;
      await api.startMeeting(meta.id);
      startedAtRef.current = Date.now();
      recordedBeforePauseRef.current = 0;
      setElapsed(0);
      setLiveLines([]);
      setDigest([]);
      setNamesHeard([]);
      setPhase('roll_call');
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
    if (view !== 'recording' || phase === 'paused') return;
    const id = window.setInterval(() => {
      setElapsed((prev) => {
        const wall =
          recordedBeforePauseRef.current + (Date.now() - startedAtRef.current) / 1000;
        return Math.max(prev, wall);
      });
      setPendingBytes(uplinkRef.current?.pendingBytes ?? 0);
    }, 1000);
    return () => window.clearInterval(id);
  }, [view, phase]);

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

  const finishRollCall = async () => {
    if (!meta) return;
    setBusy(true);
    try {
      await api.rollCallDone(meta.id);
      setPhase('recording');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Pause releases the microphone rather than just muting the upload. The
   * phone's recording indicator goes out, so the room can see it has actually
   * stopped listening -- during a break or an off-the-record aside that matters
   * more than the tokens saved.
   */
  const pauseRecording = async () => {
    if (!meta) return;
    setBusy(true);
    try {
      await recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      await uplinkRef.current?.drain(5_000);
      const updated = await api.pauseMeeting(meta.id);
      recordedBeforePauseRef.current = updated.durationSeconds ?? elapsed;
      setElapsed(recordedBeforePauseRef.current);
      setLevel(0);
      setPhase('paused');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const resumeRecording = async () => {
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      const uplink = uplinkRef.current;
      if (!uplink) throw new Error('Connection was lost. End the meeting and try again.');

      const recorder = await startRecorder(
        {
          onAudio: (pcm) => {
            uplink.send(pcm);
            setPendingBytes(uplink.pendingBytes);
          },
          onLevel: setLevel,
          onError: (err) => setError(err.message),
        },
        deviceIdRef.current,
      );
      recorderRef.current = recorder;
      setDeviceLabel(recorder.deviceLabel);

      await api.resumeMeeting(meta.id);
      // The clock continues from where the recording left off, not from zero:
      // paused time does not exist in the audio.
      startedAtRef.current = Date.now();
      setPhase('recording');
    } catch (err) {
      setError(micErrorMessage(err));
    } finally {
      setBusy(false);
    }
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
    setDigest([]);
    setElapsed(0);
    setPhase('roll_call');
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
            phase={phase}
            elapsed={elapsed}
            level={level}
            connected={connected}
            liveLines={liveLines}
            digest={digest}
            namesHeard={namesHeard}
            pendingBytes={pendingBytes}
            deviceLabel={deviceLabel}
            wakeLockHeld={wakeLockHeld}
            wakeLockSupported={ScreenLockGuard.supported}
            busy={busy || stopping}
            onRollCallDone={finishRollCall}
            onPause={pauseRecording}
            onResume={resumeRecording}
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
  const needsAttention = meetings.filter(
    (m) => m.status === 'awaiting_speakers',
  ).length;

  return (
    <>
      <div>
        <p className="eyebrow">In-person · Cantonese &amp; English</p>
        <h1>Minutes</h1>
      </div>
      <p className="sub">
        Records the meeting and drafts the formal minutes from it.
      </p>

      {error && <div className="banner error">{error}</div>}

      <button className="btn-primary" onClick={onNew}>
        Start a meeting
      </button>

      <div className="section">
        <h2>
          Past meetings
          {needsAttention > 0 && (
            <span className="badge medium" style={{ marginLeft: 8 }}>
              {needsAttention} need{needsAttention === 1 ? 's' : ''} you
            </span>
          )}
        </h2>

        {meetings.length === 0 ? (
          <p className="empty-state">
            No meetings yet.
            <br />
            Put the phone flat in the middle of the table before you start.
          </p>
        ) : (
          <div className="stack">
            {meetings.map((m) => (
              <button className="meeting-item" key={m.id} onClick={() => onOpen(m.id)}>
                <span>
                  <strong>{m.title}</strong>
                  <div className="meta">
                    {formatShortDate(m.date)}
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
        )}
      </div>

      <p className="footer-note">
        Audio is processed by Gemini on Vertex AI in your own Google Cloud
        project, and deleted once the minutes are drafted.
      </p>
    </>
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
      <>
        <div>
          <p className="eyebrow">{meta.title}</p>
          <h1>Something went wrong</h1>
        </div>
        <div className="banner error">{meta.error ?? 'Unknown error'}</div>
        <p className="sub">
          {snapshot.audioAvailable
            ? 'The recording is still on the server, so nothing is lost — this can be retried.'
            : 'The recording is no longer available.'}
        </p>
        <button className="btn-ghost" onClick={onNew}>
          Back
        </button>
      </>
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
        audioAvailable={snapshot.audioAvailable}
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
      <div>
        <p className="eyebrow">{meta.title}</p>
        <h1>{statusLabel(meta.status)}</h1>
      </div>
      <p className="sub" style={{ textAlign: 'center' }}>
        {meta.progress ?? 'Working…'}
      </p>
      <p className="hint" style={{ textAlign: 'center' }}>
        {meta.durationSeconds
          ? `${Math.round(meta.durationSeconds / 60)} minutes of audio. `
          : ''}
        You can lock the phone — this keeps running on the server.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- helpers --- */

function statusLabel(status: MeetingMeta['status']): string {
  switch (status) {
    case 'setup':
      return 'Not started';
    case 'roll_call':
      return 'Roll call';
    case 'recording':
      return 'Recording';
    case 'paused':
      return 'Paused';
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

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
