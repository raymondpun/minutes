import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { pcmDurationSeconds } from './wav.js';
import type {
  DigestBlock,
  MeetingMeta,
  MeetingStatus,
  Minutes,
  SpeakerIdentification,
  TranscriptSegment,
} from './types.js';

/**
 * Everything for one meeting lives in one directory. No database -- a meeting is
 * a folder you can zip, inspect, or delete, which is the right shape for
 * recordings of real people.
 */
export class BadMeetingId extends Error {
  readonly status = 400;
  constructor(id: string) {
    super(`Not a valid meeting id: ${id}`);
  }
}

function dir(id: string): string {
  // Ids are server-generated hex, but never build a path from client input
  // without checking it.
  if (!/^[a-z0-9-]{6,64}$/.test(id)) throw new BadMeetingId(id);
  return path.join(config.dataDir, 'meetings', id);
}

const paths = {
  meta: (id: string) => path.join(dir(id), 'meta.json'),
  pcm: (id: string) => path.join(dir(id), 'audio.pcm'),
  wav: (id: string) => path.join(dir(id), 'audio.wav'),
  live: (id: string) => path.join(dir(id), 'live.jsonl'),
  digest: (id: string) => path.join(dir(id), 'digest.jsonl'),
  transcript: (id: string) => path.join(dir(id), 'transcript.json'),
  speakers: (id: string) => path.join(dir(id), 'speakers.json'),
  minutesJson: (id: string) => path.join(dir(id), 'minutes.json'),
  minutesMd: (id: string) => path.join(dir(id), 'minutes.md'),
};

export async function createMeeting(
  input: Omit<MeetingMeta, 'id' | 'status' | 'createdAt'>,
): Promise<MeetingMeta> {
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
  const meta: MeetingMeta = {
    ...input,
    pauses: input.pauses ?? [],
    id,
    status: 'setup',
    createdAt: new Date().toISOString(),
  };
  await fsp.mkdir(dir(id), { recursive: true });
  await writeMeta(meta);
  return meta;
}

export async function readMeta(id: string): Promise<MeetingMeta> {
  const raw = await fsp.readFile(paths.meta(id), 'utf8');
  return JSON.parse(raw) as MeetingMeta;
}

/**
 * Write via a temporary file and rename.
 *
 * writeFile truncates and then writes, and on a single event loop a concurrent
 * reader lands in that window routinely -- the client polls every three seconds
 * while the pipeline writes progress several times a minute. A torn read gives
 * readMeta a SyntaxError (a 500 on a healthy meeting) or makes listMeetings
 * drop the meeting from the history entirely. rename is atomic within a
 * filesystem, so a reader sees either the old file or the new one.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

export async function writeMeta(meta: MeetingMeta): Promise<void> {
  await writeJsonAtomic(paths.meta(meta.id), meta);
}

/**
 * Serialise read-modify-write per meeting.
 *
 * patchMeta is called concurrently from HTTP handlers, the websocket's
 * roll-call check, and a fire-and-forget progress writer. Interleaved, the
 * later write is built from a stale read and silently discards the earlier
 * one -- which is how a pause mark disappears and the timeline splices two
 * conversations together with no marker.
 */
const metaQueues = new Map<string, Promise<unknown>>();

function withMetaLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = metaQueues.get(id) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  metaQueues.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

export function patchMeta(id: string, patch: Partial<MeetingMeta>): Promise<MeetingMeta> {
  return withMetaLock(id, async () => {
    const meta = { ...(await readMeta(id)), ...patch };
    await writeMeta(meta);
    return meta;
  });
}

export async function setStatus(
  id: string,
  status: MeetingStatus,
  progress?: string,
): Promise<void> {
  await patchMeta(id, { status, progress, error: undefined });
}

export async function fail(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await patchMeta(id, { status: 'failed', error: message, progress: undefined });
}

export async function listMeetings(): Promise<MeetingMeta[]> {
  const root = path.join(config.dataDir, 'meetings');
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return [];
  }
  const metas = await Promise.all(
    entries.map(async (id) => {
      try {
        return await readMeta(id);
      } catch {
        return null;
      }
    }),
  );
  return metas
    .filter((m): m is MeetingMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------------------------------------------------------- audio --- */

const appendStreams = new Map<string, fs.WriteStream>();

/**
 * Meetings whose recording is finished. Without this, a frame still in flight
 * when the meeting stops silently reopens the stream -- recreating audio.pcm
 * after the app has told the user the recording was deleted, and leaking a
 * file handle nothing will ever close.
 */
const closedRecordings = new Set<string>();

export class RecordingClosed extends Error {
  constructor(id: string) {
    super(`Recording for ${id} has already finished`);
  }
}

/**
 * Append a chunk of raw PCM. The write stream is held open for the length of
 * the meeting, so a 90 minute recording is one sequential write, not 5400
 * opens.
 */
export function appendPcm(id: string, chunk: Buffer): Promise<void> {
  if (closedRecordings.has(id)) return Promise.reject(new RecordingClosed(id));

  let stream = appendStreams.get(id);
  if (!stream) {
    fs.mkdirSync(dir(id), { recursive: true });
    stream = fs.createWriteStream(paths.pcm(id), { flags: 'a' });

    // Without this listener an fs error -- ENOSPC is entirely plausible at
    // 115 MB an hour on a container disk -- is emitted as an unhandled 'error'
    // event, which Node throws as an uncaught exception. That kills the process
    // in the middle of the meeting and takes every unflushed byte with it.
    stream.on('error', (err) => {
      console.error(`[audio] write stream failed for ${id}:`, err);
      appendStreams.delete(id);
    });

    appendStreams.set(id, stream);
  }

  const active = stream;
  return new Promise((resolve, reject) => {
    if (active.destroyed || active.writableEnded) {
      appendStreams.delete(id);
      return reject(new Error('Audio write stream is no longer usable'));
    }
    active.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

export async function closePcm(id: string): Promise<void> {
  closedRecordings.add(id);
  const stream = appendStreams.get(id);
  if (!stream) return;
  appendStreams.delete(id);
  if (stream.destroyed || stream.writableEnded) return;
  // end() will not call back on a destroyed stream, and a hung /stop would
  // strand the meeting mid-pipeline, so race it against a timeout.
  await Promise.race([
    new Promise<void>((resolve) => stream.end(resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

/** A new recording on the same id is a new recording. */
export function reopenRecording(id: string): void {
  closedRecordings.delete(id);
}

export async function pcmSize(id: string): Promise<number> {
  try {
    return (await fsp.stat(paths.pcm(id))).size;
  } catch {
    return 0;
  }
}

export async function recordedSeconds(id: string): Promise<number> {
  return pcmDurationSeconds(await pcmSize(id));
}

/** Read a byte range of the PCM without loading the whole meeting into memory. */
export async function readPcmRange(
  id: string,
  startByte: number,
  endByte: number,
): Promise<Buffer> {
  const handle = await fsp.open(paths.pcm(id), 'r');
  try {
    const length = Math.max(0, endByte - startByte);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, startByte);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const pcmPath = paths.pcm;
export const wavPath = paths.wav;
export const meetingDir = dir;
export const meetingsRoot = () => path.join(config.dataDir, 'meetings');

/* ----------------------------------------------------------- transcripts --- */

export async function appendLive(
  id: string,
  line: { start: number; end: number; text: string },
): Promise<void> {
  await fsp.appendFile(paths.live(id), `${JSON.stringify(line)}\n`);
}

export async function readLive(
  id: string,
): Promise<Array<{ start: number; end: number; text: string }>> {
  try {
    const raw = await fsp.readFile(paths.live(id), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function appendDigest(id: string, block: DigestBlock): Promise<void> {
  await fsp.appendFile(paths.digest(id), `${JSON.stringify(block)}\n`);
}

export async function readDigest(id: string): Promise<DigestBlock[]> {
  try {
    const raw = await fsp.readFile(paths.digest(id), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DigestBlock);
  } catch {
    return [];
  }
}

export async function writeTranscript(
  id: string,
  segments: TranscriptSegment[],
): Promise<void> {
  await writeJsonAtomic(paths.transcript(id), segments);
}

export async function readTranscript(id: string): Promise<TranscriptSegment[]> {
  try {
    return JSON.parse(await fsp.readFile(paths.transcript(id), 'utf8'));
  } catch {
    return [];
  }
}

export async function writeSpeakers(
  id: string,
  speakers: SpeakerIdentification[],
): Promise<void> {
  await writeJsonAtomic(paths.speakers(id), speakers);
}

export async function readSpeakers(id: string): Promise<SpeakerIdentification[]> {
  try {
    return JSON.parse(await fsp.readFile(paths.speakers(id), 'utf8'));
  } catch {
    return [];
  }
}

export async function writeMinutes(
  id: string,
  minutes: Minutes,
  markdown: string,
): Promise<void> {
  // Two files that must agree: the .docx renders from the JSON and the .md
  // download is the file, so a half-applied pair ships two different documents.
  await writeJsonAtomic(paths.minutesJson(id), minutes);
  const tmp = `${paths.minutesMd(id)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, markdown);
  await fsp.rename(tmp, paths.minutesMd(id));
}

export async function readMinutes(
  id: string,
): Promise<{ minutes: Minutes; markdown: string } | null> {
  try {
    const minutes = JSON.parse(await fsp.readFile(paths.minutesJson(id), 'utf8'));
    const markdown = await fsp.readFile(paths.minutesMd(id), 'utf8');
    return { minutes, markdown };
  } catch {
    return null;
  }
}

/**
 * Delete the raw audio but keep the transcript and minutes. Called after a
 * successful draft: the recording of people's voices is the most sensitive
 * artifact here and there is no reason to keep it by default.
 */
export async function deleteAudio(id: string): Promise<void> {
  await closePcm(id);
  await Promise.allSettled([
    fsp.rm(paths.pcm(id), { force: true }),
    fsp.rm(paths.wav(id), { force: true }),
  ]);
}

export async function deleteMeeting(id: string): Promise<void> {
  await closePcm(id);
  await fsp.rm(dir(id), { recursive: true, force: true });
}
