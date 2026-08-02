import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { bytesPerSecond, config } from './config.js';
import * as store from './store.js';
import * as gcs from './gcs.js';
import { transcribeChunk } from './pipeline/live.js';
import { buildTranscript } from './pipeline/transcribe.js';
import { applySpeakerNames, identifySpeakers } from './pipeline/identify.js';
import { draftMinutes, renderMarkdown } from './pipeline/minutes.js';
import { pcmDurationSeconds } from './wav.js';
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
        err instanceof store.BadMeetingId
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

/* ------------------------------------------------------------------ api --- */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    project: config.projectId,
    location: config.location,
    models: config.models,
    singlePassTranscription: Boolean(config.gcsBucket),
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
    });
    res.status(201).json(meta);
  }),
);

app.get(
  '/api/meetings/:id',
  wrap(async (req, res) => {
    const id = req.params.id!;
    const meta = await store.readMeta(id);
    const [transcript, speakers, minutes, live, audioBytes] = await Promise.all([
      store.readTranscript(id),
      store.readSpeakers(id),
      store.readMinutes(id),
      store.readLive(id),
      store.pcmSize(id),
    ]);
    res.json({
      meta,
      transcript,
      speakers,
      minutes: minutes?.minutes ?? null,
      markdown: minutes?.markdown ?? null,
      live,
      audioSeconds: pcmDurationSeconds(audioBytes),
      audioAvailable: audioBytes > 0,
    });
  }),
);

app.post(
  '/api/meetings/:id/start',
  wrap(async (req, res) => {
    const meta = await store.patchMeta(req.params.id!, {
      status: 'recording',
      startedAt: localTime(),
      progress: undefined,
      error: undefined,
    });
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
    await store.closePcm(id);
    const updated = await store.patchMeta(id, {
      status: 'transcribing',
      endedAt: localTime(),
      durationSeconds: await store.recordedSeconds(id),
      progress: 'Preparing recording',
    });
    void runTranscription(id);
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

    await store.writeSpeakers(id, merged);
    await store.patchMeta(id, { status: 'drafting', progress: 'Drafting minutes' });
    void runDrafting(id);
    res.json({ speakers: merged });
  }),
);

app.post(
  '/api/meetings/:id/minutes/regenerate',
  wrap(async (req, res) => {
    const id = req.params.id!;
    await store.patchMeta(id, { status: 'drafting', progress: 'Redrafting minutes' });
    void runDrafting(id);
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

async function runTranscription(id: string): Promise<void> {
  try {
    const meta = await store.readMeta(id);

    const transcript = await buildTranscript(id, meta.expectedAttendees, (message) => {
      void store.patchMeta(id, { progress: message });
    });
    await store.writeTranscript(id, transcript);

    await store.setStatus(id, 'identifying', 'Identifying who said what');
    const speakers = await identifySpeakers(transcript, meta.expectedAttendees);
    await store.writeSpeakers(id, speakers);

    await store.setStatus(id, 'awaiting_speakers', 'Confirm the attendee names');
  } catch (err) {
    console.error(`[pipeline] transcription failed for ${id}:`, err);
    await store.fail(id, err);
  }
}

async function runDrafting(id: string): Promise<void> {
  try {
    const meta = await store.readMeta(id);
    const speakers = await store.readSpeakers(id);
    const raw = await store.readTranscript(id);
    const named = applySpeakerNames(raw, speakers);

    const minutes = await draftMinutes(meta, named, speakers);
    await store.writeMinutes(id, minutes, renderMarkdown(minutes));

    // The recording has served its purpose. Keeping voice recordings of
    // colleagues around by default is not a decision to make silently.
    await store.deleteAudio(id);
    await gcs.deleteAudio(id).catch(() => {});

    await store.setStatus(id, 'complete');
  } catch (err) {
    console.error(`[pipeline] drafting failed for ${id}:`, err);
    await store.fail(id, err);
  }
}

/* ----------------------------------------------------------- websocket --- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** ~20 seconds of audio before we send a chunk off for a live transcription. */
const CHUNK_SECONDS = 20;
const CHUNK_BYTES = CHUNK_SECONDS * bytesPerSecond;

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

        if (pendingBytes < CHUNK_BYTES) return;

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
    // Nothing to salvage: every frame was written to disk the moment it
    // arrived. `pending` only buffers toward the next live transcription, which
    // is disposable -- the real transcript comes from the file.
    pending = [];
    pendingBytes = 0;
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

const shutdown = () => {
  console.log('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export type MeetingResponse = MeetingMeta;
