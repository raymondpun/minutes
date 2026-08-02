import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { config, liveChunkBytes } from './config.js';
import * as store from './store.js';
import * as gcs from './gcs.js';
import { transcribeChunk } from './pipeline/live.js';
import { buildDigest } from './pipeline/digest.js';
import { checkRollCall } from './pipeline/rollcall.js';
import { buildTranscript } from './pipeline/transcribe.js';
import { applySpeakerNames, identifySpeakers } from './pipeline/identify.js';
import { draftMinutes, renderMarkdown } from './pipeline/minutes.js';
import { renderDocx } from './pipeline/docx.js';
import { pcmDurationSeconds, pcmToWav, secondsToByteOffset } from './wav.js';
import type { MeetingMeta, ServerEvent, SpeakerIdentification } from './types.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

if (config.corsOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof WrongStatus
          ? 409
          : err instanceof store.BadMeetingId
            ? 400
            : (err as NodeJS.ErrnoException)?.code === 'ENOENT'
              ? 404
              : 500;
      if (status === 500) console.error(`[api] ${req.method} ${req.path} failed:`, err);
      if (!res.headersSent) {
        res.status(status).json({
          error: status === 404 ? 'Meeting not found' : message,
        });
      }
    });
  };

/**
 * Reject a lifecycle action that does not make sense for the meeting's current
 * state. Without this, an ordinary retry from a stale tab can push a finished
 * meeting back into the pipeline -- and since the audio is gone by then,
 * transcription throws "No audio was recorded" and a meeting with perfectly
 * good minutes ends up displaying as failed.
 */
class WrongStatus extends Error {
  readonly status = 409;
  constructor(action: string, actual: MeetingMeta['status'], allowed: readonly string[]) {
    super(
      `Cannot ${action} a meeting that is "${actual}" — only ${allowed.join(' or ')}.`,
    );
  }
}

function requireStatus(
  meta: MeetingMeta,
  action: string,
  allowed: readonly MeetingMeta['status'][],
): void {
  if (!allowed.includes(meta.status)) throw new WrongStatus(action, meta.status, allowed);
}

/* ------------------------------------------------------------------ api --- */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    project: config.projectId,
    location: config.location,
    models: config.models,
    singlePassTranscription: Boolean(config.gcsBucket),
    // JSON.stringify turns Infinity into null, which the client would read as
    // "unknown" and describe wrongly in the consent announcement.
    retainAudioDays: Number.isFinite(config.retainAudioDays)
      ? config.retainAudioDays
      : 'forever',
  });
});

app.get(
  '/api/meetings',
  wrap(async (_req, res) => {
    res.json(await store.listMeetings());
  }),
);

app.post(
  '/api/meetings',
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const meta = await store.createMeeting({
      title: String(b.title ?? 'Meeting').trim() || 'Meeting',
      body: String(b.body ?? '').trim(),
      location: String(b.location ?? '').trim(),
      date: String(b.date ?? new Date().toISOString().slice(0, 10)),
      chair: b.chair ? String(b.chair).trim() : undefined,
      secretary: b.secretary ? String(b.secretary).trim() : undefined,
      expectedAttendees: toStringArray(b.expectedAttendees),
      apologies: toStringArray(b.apologies),
      agenda: toStringArray(b.agenda),
      pauses: [],
    });
    res.status(201).json(meta);
  }),
);

app.get(
  '/api/meetings/:id',
  wrap(async (req, res) => {
    const id = req.params.id!;
    // On a cold start only the meeting index was restored, so pull this
    // meeting's documents down the first time it is opened.
    if (gcs.enabled()) {
      await gcs
        .restoreMeeting(id, store.meetingDir(id))
        .catch((err) => console.warn(`[archive] restore failed for ${id}:`, err));
    }
    const meta = await store.readMeta(id);
    resumeIfStalled(meta);
    const [transcript, speakers, minutes, live, digest, audioBytes] = await Promise.all([
      store.readTranscript(id),
      store.readSpeakers(id),
      store.readMinutes(id),
      store.readLive(id),
      store.readDigest(id),
      store.pcmSize(id),
    ]);
    res.json({
      meta,
      transcript,
      speakers,
      minutes: minutes?.minutes ?? null,
      markdown: minutes?.markdown ?? null,
      live,
      digest,
      audioSeconds: pcmDurationSeconds(audioBytes),
      // Playback works from either the local copy or the retained one in
      // Cloud Storage, so the client asks about both.
      audioAvailable: audioBytes > 0 || (await gcs.audioExists(id).catch(() => false)),
    });
  }),
);

/**
 * Begin recording, starting with the roll call.
 *
 * The roll call is the opening stretch of the same continuous recording rather
 * than a separate clip: matching a voice to a name only works if both were
 * captured by the same microphone in the same room in one pass.
 */
app.post(
  '/api/meetings/:id/start',
  wrap(async (req, res) => {
    requireStatus(await store.readMeta(req.params.id!), 'start', ['setup']);
    store.reopenRecording(req.params.id!);
    const meta = await store.patchMeta(req.params.id!, {
      status: 'roll_call',
      startedAt: localTime(),
      progress: undefined,
      error: undefined,
    });
    res.json(meta);
  }),
);

/** Roll call finished -- mark where it ended and move into the meeting proper. */
app.post(
  '/api/meetings/:id/roll-call-done',
  wrap(async (req, res) => {
    const id = req.params.id!;
    requireStatus(await store.readMeta(id), 'end the roll call of', ['roll_call']);
    const meta = await store.patchMeta(id, {
      status: 'recording',
      rollCallEndedAt: await store.recordedSeconds(id),
    });
    res.json(meta);
  }),
);

/**
 * Pause. The client releases the microphone, so the phone's recording
 * indicator goes out and the room can see it has stopped -- which matters more
 * than the tokens saved during a coffee break or an off-the-record aside.
 */
app.post(
  '/api/meetings/:id/pause',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const meta = await store.readMeta(id);
    requireStatus(meta, 'pause', ['recording', 'roll_call']);
    const at = await store.recordedSeconds(id);
    const updated = await store.patchMeta(id, {
      status: 'paused',
      pauses: [...(meta.pauses ?? []), { at }],
    });
    res.json(updated);
  }),
);

app.post(
  '/api/meetings/:id/resume',
  wrap(async (req, res) => {
    requireStatus(await store.readMeta(req.params.id!), 'resume', ['paused']);
    const meta = await store.patchMeta(req.params.id!, { status: 'recording' });
    res.json(meta);
  }),
);

/**
 * End the meeting. Transcription of a long recording takes minutes, and a phone
 * on a flaky connection will not hold an HTTP request open that long -- so this
 * kicks off a background job and the client polls GET /api/meetings/:id.
 */
app.post(
  '/api/meetings/:id/stop',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const meta = await store.readMeta(id);
    if (meta.status === 'transcribing' || meta.status === 'identifying') {
      return res.json(meta);
    }
    // Stopping a meeting that is already past recording would re-transcribe it
    // and overwrite the human-corrected speaker names with fresh model output.
    requireStatus(meta, 'stop', ['roll_call', 'recording', 'paused']);
    await store.closePcm(id);
    const updated = await store.patchMeta(id, {
      status: 'transcribing',
      endedAt: localTime(),
      durationSeconds: await store.recordedSeconds(id),
      progress: 'Preparing recording',
    });
    // Archive the meeting record before the long transcription starts. Until
    // now nothing reached Cloud Storage until transcription finished, so an
    // instance reclaimed mid-pipeline left the meeting with no meta.json in the
    // bucket -- absent from restoreIndex, never resumed, silently gone.
    await archive(id);
    startJob(id, runTranscription);
    res.json(updated);
  }),
);

/**
 * Confirm or correct the speaker names, then draft. The human check sits here
 * on purpose: a name attached to the wrong resolution is the single most
 * damaging error this app can make, and it costs ten seconds to prevent.
 */
app.put(
  '/api/meetings/:id/speakers',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const incoming = Array.isArray(req.body?.speakers) ? req.body.speakers : [];
    const existing = await store.readSpeakers(id);

    const merged: SpeakerIdentification[] = existing.map((s) => {
      const patch = incoming.find(
        (i: { speakerId?: string }) => i?.speakerId === s.speakerId,
      );
      if (!patch) return s;
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      return {
        ...s,
        name: name.length ? name : null,
        role: typeof patch.role === 'string' && patch.role.trim() ? patch.role.trim() : s.role,
        // A human typed it, so it is no longer a guess.
        confidence: name.length && name !== s.name ? 'high' : s.confidence,
      };
    });

    // Never let a cold instance's empty roster overwrite a real one. This
    // endpoint drives its merge from what is on disk, and readSpeakers returns
    // [] for "not on this instance" just as readily as for "none" -- which
    // would destroy the names the user just typed, locally and in the bucket.
    if (merged.length === 0 && incoming.length > 0) {
      return res
        .status(409)
        .json({ error: 'The speaker list is not loaded on this server yet. Reopen the meeting and try again.' });
    }

    await store.writeSpeakers(id, merged);
    await archive(id);
    await store.patchMeta(id, { status: 'drafting', progress: 'Drafting minutes' });
    startJob(id, runDrafting);
    res.json({ speakers: merged });
  }),
);

app.post(
  '/api/meetings/:id/minutes/regenerate',
  wrap(async (req, res) => {
    const id = req.params.id!;
    requireStatus(await store.readMeta(id), 'redraft', ['complete', 'failed', 'awaiting_speakers']);
    if (gcs.enabled()) {
      await gcs.restoreMeeting(id, store.meetingDir(id)).catch(() => {});
    }
    await store.patchMeta(id, { status: 'drafting', progress: 'Redrafting minutes' });
    startJob(id, runDrafting);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/meetings/:id/minutes.md',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const result = await store.readMinutes(id);
    if (!result) return res.status(404).json({ error: 'No minutes yet' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="minutes-${id}.md"`);
    res.send(result.markdown);
  }),
);

/**
 * The minutes as a Word document. Markdown is fine for a developer and useless
 * to a company secretary -- formal minutes get tabled, circulated, put on
 * letterhead and signed, and all of that happens in Word.
 */
app.get(
  '/api/meetings/:id/minutes.docx',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const result = await store.readMinutes(id);
    if (!result) return res.status(404).json({ error: 'No minutes yet' });

    const buffer = await renderDocx(result.minutes);
    const slug = `${result.minutes.date}-${result.minutes.title}`
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="minutes-${slug}.docx"`);
    res.send(buffer);
  }),
);

app.get(
  '/api/meetings/:id/transcript.txt',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const transcript = await store.readTranscript(id);
    const text = transcript
      .map((s) => `[${formatTimestamp(s.start)}] ${s.speaker}: ${s.text}`)
      .join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${id}.txt"`);
    res.send(text);
  }),
);

/**
 * A few seconds of audio around a timestamp.
 *
 * Every quote in the minutes carries the time it was said, so this is what
 * turns the evidence layer from "trust the translation" into "listen to it".
 * Serves a small standalone WAV rather than a range of the full recording, so
 * a phone fetches kilobytes instead of a couple of hundred megabytes.
 */
app.get(
  '/api/meetings/:id/clip',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const at = Number(req.query.at);
    if (!Number.isFinite(at) || at < 0) {
      return res.status(400).json({ error: 'A valid ?at= position in seconds is required' });
    }
    // Start slightly before the quote: people rarely remember the exact moment,
    // and the run-up is usually what makes it make sense.
    const pad = Math.min(30, Math.max(2, Number(req.query.pad) || 6));
    const from = Math.max(0, at - pad);
    const to = at + pad;
    const startByte = secondsToByteOffset(from);
    const endByte = secondsToByteOffset(to);

    let pcm: Buffer | null = null;
    if ((await store.pcmSize(id)) > 0) {
      pcm = await store.readPcmRange(id, startByte, endByte);
    } else if (gcs.enabled() && (await gcs.audioExists(id))) {
      pcm = await gcs.readAudioRange(id, startByte, endByte);
    }

    if (!pcm || pcm.length === 0) {
      return res.status(404).json({ error: 'The recording is no longer available' });
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(pcmToWav(pcm));
  }),
);

app.delete(
  '/api/meetings/:id/audio',
  wrap(async (req, res) => {
    const id = req.params.id!;
    await store.deleteAudio(id);
    await gcs.deleteAudio(id).catch(() => {});
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/meetings/:id',
  wrap(async (req, res) => {
    const id = req.params.id!;
    await store.deleteMeeting(id);
    await gcs.deleteAudio(id).catch(() => {});
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------ pipeline --- */

/**
 * Which meetings this process is actively working on.
 *
 * Needed because the post-meeting pipeline outlives the request that started
 * it, and on Cloud Run an instance can be reclaimed once traffic stops. If that
 * happens mid-transcription the meeting would sit at "transcribing" forever
 * with nothing running. Instead any request touching a meeting whose status
 * claims work is in progress -- including the client's own status poll --
 * restarts it. Every stage reads its inputs from disk and rewrites its outputs,
 * so restarting is safe and simply redoes the stage.
 */
const running = new Set<string>();

/**
 * Start a pipeline stage unless one is already running for this meeting.
 *
 * The Set was only ever consulted by the stall-resumer, so a retried request or
 * a double tap started a second concurrent pipeline: two drafts interleaving
 * their writes, and whichever finished first clearing the flag and overwriting
 * the other's status -- a meeting with good minutes ending up marked failed.
 */
function startJob(id: string, job: (id: string) => Promise<void>): boolean {
  if (running.has(id)) {
    console.warn(`[pipeline] ${id} already has a stage running; ignoring duplicate start`);
    return false;
  }
  void job(id);
  return true;
}

/**
 * Copy the meeting's documents to Cloud Storage if one is configured. Never
 * fatal: a meeting that exists locally but failed to archive is still a
 * meeting, and the user should not lose a draft to a bucket permission error.
 */
/**
 * Make sure the recording is in Cloud Storage before the local copy is dropped.
 * Single-pass transcription already uploaded it; the segmented path did not.
 */
async function ensureAudioArchived(id: string): Promise<boolean> {
  try {
    if (await gcs.audioExists(id)) return true;
    const size = await store.pcmSize(id);
    if (size === 0) return false;
    const pcm = await store.readPcmRange(id, 0, size);
    await gcs.uploadAudio(id, pcmToWav(pcm));
    return true;
  } catch (err) {
    console.warn(`[archive] could not retain audio for ${id}:`, err);
    return false;
  }
}

async function archive(id: string): Promise<void> {
  if (!gcs.enabled()) return;
  try {
    await gcs.archiveMeeting(id, store.meetingDir(id));
  } catch (err) {
    console.warn(`[archive] could not archive ${id}:`, err);
  }
}

function resumeIfStalled(meta: MeetingMeta): void {
  if (running.has(meta.id)) return;
  if (meta.status === 'transcribing' || meta.status === 'identifying') {
    console.warn(`[pipeline] resuming interrupted transcription for ${meta.id}`);
    void runTranscription(meta.id);
  } else if (meta.status === 'drafting') {
    console.warn(`[pipeline] resuming interrupted drafting for ${meta.id}`);
    void runDrafting(meta.id);
  }
}

async function runTranscription(id: string): Promise<void> {
  running.add(id);
  try {
    const meta = await store.readMeta(id);

    const transcript = await buildTranscript(id, meta.expectedAttendees, (message) => {
      void store.patchMeta(id, { progress: message });
    });
    await store.writeTranscript(id, transcript);

    await store.setStatus(id, 'identifying', 'Identifying who said what');
    const speakers = await identifySpeakers(
      transcript,
      meta.expectedAttendees,
      meta.rollCallEndedAt,
    );
    await store.writeSpeakers(id, speakers);

    /**
     * Only stop for a human when there is actually something to decide.
     *
     * The reason this checkpoint exists is that a name attached to the wrong
     * resolution is the worst thing this app can produce. But that risk lives
     * entirely in the uncertain cases -- an unnamed voice, or a name the model
     * inferred rather than heard. When every speaker introduced themselves and
     * was matched confidently, stopping to ask adds nothing except a step
     * between the chair and their minutes.
     *
     * Anything uncertain still reaches the reader: it is raised in the minutes'
     * own "to verify before sign-off" list either way -- including the medium
     * confidence names this lets through, which the prompt defines as a single
     * piece of evidence rather than a heard introduction.
     */
    const uncertain = speakers.filter((sp) => !sp.name || sp.confidence === 'low');

    if (uncertain.length === 0 && speakers.length > 0) {
      console.log(`[pipeline] all ${speakers.length} speakers identified; drafting`);
      await store.setStatus(id, 'drafting', 'Drafting minutes');
      await archive(id);
      await runDrafting(id);
      return;
    }

    await store.setStatus(
      id,
      'awaiting_speakers',
      uncertain.length === 1
        ? '1 speaker needs a name'
        : `${uncertain.length} speakers need names`,
    );
    await archive(id);
  } catch (err) {
    console.error(`[pipeline] transcription failed for ${id}:`, err);
    await store.fail(id, err);
  } finally {
    running.delete(id);
  }
}

async function runDrafting(id: string): Promise<void> {
  running.add(id);
  try {
    const meta = await store.readMeta(id);
    const speakers = await store.readSpeakers(id);
    const raw = await store.readTranscript(id);
    const named = applySpeakerNames(raw, speakers);

    const minutes = await draftMinutes(meta, named, speakers);
    await store.writeMinutes(id, minutes, renderMarkdown(minutes));

    // What happens to the recording is a promise made to the room, so the code
    // has to keep it exactly.
    //
    // The local copy is only dropped once the audio is provably somewhere else.
    // Deleting it because a bucket *should* have taken it -- or because no
    // bucket was configured at all -- destroys the recording while the consent
    // announcement, which reads the same retainAudioDays, has just told
    // everyone present it would be kept.
    if (config.retainAudioDays === 0) {
      await gcs.deleteAudio(id).catch(() => {});
      await store.deleteAudio(id);
    } else if (gcs.enabled() && (await ensureAudioArchived(id))) {
      await store.deleteAudio(id);
    } else {
      console.warn(
        `[retention] keeping the local recording for ${id}: ` +
          (gcs.enabled()
            ? 'it could not be archived to Cloud Storage'
            : 'no GCS_BUCKET is configured, so this is the only copy'),
      );
    }

    await store.setStatus(id, 'complete');
    await archive(id);
  } catch (err) {
    console.error(`[pipeline] drafting failed for ${id}:`, err);
    await store.fail(id, err);
  } finally {
    running.delete(id);
  }
}

/* ----------------------------------------------------------- websocket --- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Chunk sizing lives in config.ts so it can be tested without booting a server.

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const meetingId = url.searchParams.get('meeting');

  if (!meetingId) {
    ws.close(1008, 'meeting id required');
    return;
  }

  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let chunkIndex = 0;
  let tail = '';
  /** Serialises live transcriptions so chunks come back in order. */
  let liveQueue: Promise<void> = Promise.resolve();

  // Roll-call state. The phase ends by itself; the button is only a shortcut.
  let rollCallText: string[] = [];
  let rollCallChecking = false;
  let rollCallDone = false;

  /**
   * Watch the opening of the meeting and move on once the introductions have
   * clearly finished, so nobody has to press anything mid-roll-call.
   */
  const maybeEndRollCall = async (nowSeconds: number) => {
    if (rollCallDone || rollCallChecking || rollCallText.length === 0) return;

    const meta = await store.readMeta(meetingId).catch(() => null);
    // A transient read failure is not evidence the roll call ended, and neither
    // is a pause. Latching on either would disable auto-detection for the rest
    // of the meeting and leave rollCallEndedAt unset.
    if (!meta) return;
    if (meta.status === 'paused') return;
    if (meta.status !== 'roll_call') {
      rollCallDone = true;
      return;
    }

    // Hard stop. If the check keeps saying "not yet" -- a rambling chair, a
    // transcript too poor to read -- the meeting still has to start, and the
    // identification step works from the whole recording regardless.
    const overrun = nowSeconds >= config.rollCall.maxSeconds;

    rollCallChecking = true;
    try {
      const verdict = overrun
        ? { finished: true, namesHeard: [], reason: 'time limit reached' }
        : await checkRollCall(rollCallText.join('\n'), meta.expectedAttendees);

      if (!verdict.finished) return;

      rollCallDone = true;
      const updated = await store.patchMeta(meetingId, {
        status: 'recording',
        rollCallEndedAt: nowSeconds,
      });
      console.log(
        `[roll-call] ended at ${nowSeconds.toFixed(0)}s (${verdict.reason}); heard: ${
          verdict.namesHeard.join(', ') || 'nobody'
        }`,
      );
      send({ type: 'roll_call_ended', at: nowSeconds, namesHeard: verdict.namesHeard });
      void updated;
    } catch (err) {
      // Never let this block the meeting. Worst case the chair taps the button.
      console.warn('[roll-call] check failed:', err);
    } finally {
      rollCallChecking = false;
    }
  };

  // Rolling summary state.
  let digestBuffer: string[] = [];
  let digestFrom = 0;
  let digestHeadings: string[] = [];
  let digestRunning = false;

  /**
   * Fold everything transcribed since the last block into a summary block.
   * Runs off the live transcript rather than the audio, so it costs almost
   * nothing on top of a pass that was happening anyway.
   */
  const maybeDigest = async (nowSeconds: number, force = false) => {
    if (digestRunning || digestBuffer.length === 0) return;
    const elapsed = nowSeconds - digestFrom;
    if (!force && elapsed < config.digestIntervalSeconds) return;
    // A forced flush of a few seconds of speech is not worth a summary block.
    if (force && elapsed < 45) return;

    digestRunning = true;
    const text = digestBuffer.join('\n');
    const from = digestFrom;
    digestBuffer = [];
    digestFrom = nowSeconds;

    try {
      const block = await buildDigest({
        text,
        recentHeadings: digestHeadings.slice(-3),
        fromSeconds: from,
        toSeconds: nowSeconds,
      });
      digestHeadings.push(block.heading);
      await store.appendDigest(meetingId, block);
      send({ type: 'digest', block });
    } catch (err) {
      // The summary is a convenience, but losing the window silently is not:
      // digestFrom has already advanced, so the gap would be invisible. Put the
      // text back so the next block covers it.
      console.warn('[digest] block failed, folding the window into the next one:', err);
      digestBuffer = [...text.split('\n'), ...digestBuffer];
      digestFrom = Math.min(digestFrom, from);
    } finally {
      digestRunning = false;
    }
  };

  store
    .readMeta(meetingId)
    .then(() => send({ type: 'ready', meetingId }))
    .catch(() => ws.close(1008, 'unknown meeting'));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return; // Control frames reserved for future use.

    void (async () => {
      try {
        await store.appendPcm(meetingId, data);
        pending.push(data);
        pendingBytes += data.length;

        const seconds = await store.recordedSeconds(meetingId);
        send({ type: 'chunk_ack', index: chunkIndex, seconds });

        if (pendingBytes < liveChunkBytes(seconds)) return;

        const chunk = Buffer.concat(pending);
        const endsAt = seconds;
        const startsAt = Math.max(0, endsAt - pcmDurationSeconds(chunk.length));
        const index = chunkIndex++;
        pending = [];
        pendingBytes = 0;

        liveQueue = liveQueue.then(async () => {
          try {
            const text = await transcribeChunk(chunk, tail);
            if (!text) return;
            tail = text.slice(-240);
            await store.appendLive(meetingId, { start: startsAt, end: endsAt, text });
            send({ type: 'live', start: startsAt, end: endsAt, text });

            rollCallText.push(text);
            void maybeEndRollCall(endsAt);

            digestBuffer.push(text);
            void maybeDigest(endsAt);
          } catch (err) {
            // A failed live chunk is cosmetic -- the audio is already safe on
            // disk and the real transcript is built from that at the end.
            console.warn(`[live] chunk ${index} failed:`, err);
          }
        });
      } catch (err) {
        console.error('[ws] failed to persist audio chunk:', err);
        send({ type: 'error', message: 'Failed to save audio' });
      }
    })();
  });

  ws.on('close', () => {
    // Nothing to salvage from the audio: every frame was written to disk the
    // moment it arrived. `pending` only buffers toward the next live
    // transcription, which is disposable -- the real transcript comes from the
    // file. But flush the trailing summary block so the last stretch of the
    // meeting is not missing from the scrollback.
    pending = [];
    pendingBytes = 0;
    void store
      .recordedSeconds(meetingId)
      .then((seconds) => maybeDigest(seconds, true))
      .catch(() => {});
  });
});

/* ------------------------------------------------------------- statics --- */

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

/* ---------------------------------------------------------------- boot --- */

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function localTime(): string {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

fs.mkdirSync(path.join(config.dataDir, 'meetings'), { recursive: true });

// Cloud Run reclaims the instance -- and its disk -- whenever traffic stops, so
// past meetings are restored from Cloud Storage before anything else. Then pick
// up any pipeline a previous instance was killed in the middle of, rather than
// leaving a meeting stuck reporting progress nothing is making.
void (async () => {
  try {
    if (gcs.enabled()) {
      const started = Date.now();
      const restored = await gcs.restoreIndex(store.meetingsRoot());
      if (restored > 0) {
        console.log(
          `[boot] restored ${restored} meeting(s) into the index in ${Date.now() - started}ms`,
        );
      }
    }
    const all = await store.listMeetings();
    all.forEach(resumeIfStalled);
  } catch (err) {
    console.warn('[boot] archive restore / stall scan failed:', err);
  }
})();

server.listen(config.port, () => {
  console.log(`minutes server on :${config.port}`);
  console.log(`  project        ${config.projectId} (${config.location})`);
  console.log(`  models         ${JSON.stringify(config.models)}`);
  console.log(
    `  transcription  ${config.gcsBucket ? `single pass via gs://${config.gcsBucket}` : 'segmented (set GCS_BUCKET for single pass)'}`,
  );
  console.log(`  data           ${config.dataDir}`);
});

// Do not lose a recording because a request threw somewhere unexpected.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});

// A meeting in progress is unrepeatable. Staying up with a logged error beats
// dying and taking the recording with us.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
});

const shutdown = () => {
  console.log('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export type MeetingResponse = MeetingMeta;
