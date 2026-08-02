import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';

let storage: Storage | undefined;

function client(): Storage {
  storage ??= new Storage({ projectId: config.projectId });
  return storage;
}

export const enabled = (): boolean => Boolean(config.gcsBucket);

/**
 * Upload the full recording so Vertex can read it by reference. Inline audio is
 * capped at a request-size limit that a meeting of any real length blows past;
 * a gs:// URI lets Gemini take the whole thing in one pass, which is what keeps
 * speaker labels consistent from the first minute to the last.
 */
export async function uploadAudio(
  meetingId: string,
  bytes: Buffer,
  contentType = 'audio/wav',
): Promise<string> {
  if (!config.gcsBucket) throw new Error('GCS_BUCKET is not configured');
  const objectName = `meetings/${meetingId}/audio.wav`;
  await client().bucket(config.gcsBucket).file(objectName).save(bytes, {
    contentType,
    resumable: false,
  });
  return `gs://${config.gcsBucket}/${objectName}`;
}

/**
 * Upload the recording without ever holding it in memory.
 *
 * A two hour meeting is ~230 MB, and reading it into a Buffer then concatenating
 * a WAV header made a second full copy -- ~460 MB peak on an instance that also
 * has to keep capturing audio. The header is 44 bytes and the rest is the file,
 * so stream both straight through.
 */
export async function uploadAudioFromFile(
  meetingId: string,
  pcmPath: string,
  header: Buffer,
): Promise<string> {
  if (!config.gcsBucket) throw new Error('GCS_BUCKET is not configured');
  const objectName = `meetings/${meetingId}/audio.wav`;

  const target = client()
    .bucket(config.gcsBucket)
    .file(objectName)
    .createWriteStream({ contentType: 'audio/wav', resumable: true });

  async function* body() {
    yield header;
    for await (const chunk of fs.createReadStream(pcmPath)) yield chunk as Buffer;
  }

  await pipeline(Readable.from(body()), target);
  return `gs://${config.gcsBucket}/${objectName}`;
}

/** Called when retention is off -- the recording should not outlive its purpose. */
export async function deleteAudio(meetingId: string): Promise<void> {
  if (!config.gcsBucket) return;
  await client()
    .bucket(config.gcsBucket)
    .file(`meetings/${meetingId}/audio.wav`)
    .delete({ ignoreNotFound: true });
}

export async function audioExists(meetingId: string): Promise<boolean> {
  if (!config.gcsBucket) return false;
  const [exists] = await client()
    .bucket(config.gcsBucket)
    .file(`meetings/${meetingId}/audio.wav`)
    .exists();
  return exists;
}

/**
 * Read a byte range out of the stored WAV without downloading the whole thing.
 *
 * A two hour recording is a couple of hundred megabytes; pulling all of it to
 * play back eight seconds would make the feature useless on a phone. Offsets
 * are into the PCM payload -- the 44 byte header is added here.
 */
export async function readAudioRange(
  meetingId: string,
  startByte: number,
  endByte: number,
): Promise<Buffer> {
  if (!config.gcsBucket) throw new Error('GCS_BUCKET is not configured');
  const HEADER = 44;
  const stream = client()
    .bucket(config.gcsBucket)
    .file(`meetings/${meetingId}/audio.wav`)
    .createReadStream({
      start: HEADER + startByte,
      // GCS ranges are inclusive.
      end: HEADER + endByte - 1,
    });

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/* -------------------------------------------------------------- archive --- */

/**
 * The text artifacts worth keeping. Not the audio -- that is deleted once the
 * minutes exist -- and not the raw PCM, which is large and transient.
 */
const ARCHIVED = [
  'meta.json',
  'minutes.json',
  'minutes.md',
  'transcript.json',
  'speakers.json',
  'digest.jsonl',
  'live.jsonl',
] as const;

/**
 * Copy a finished meeting's documents to Cloud Storage.
 *
 * Cloud Run's filesystem dies with the instance, and the instance is reclaimed
 * whenever traffic stops -- which, for an app used a few hours a week, is most
 * of the time. Without this, every past meeting would disappear between
 * meetings. This is what makes scale-to-zero safe rather than lossy.
 */
export async function archiveMeeting(meetingId: string, dir: string): Promise<void> {
  if (!config.gcsBucket) return;
  const bucket = client().bucket(config.gcsBucket);

  await Promise.all(
    ARCHIVED.map(async (name) => {
      let contents: Buffer;
      try {
        contents = await fsp.readFile(path.join(dir, name));
      } catch {
        return; // Stage has not produced this file yet.
      }
      await bucket
        .file(`meetings/${meetingId}/${name}`)
        .save(contents, { resumable: false });
    }),
  );
}

async function download(
  objectName: string,
  dest: string,
): Promise<boolean> {
  try {
    await fsp.access(dest);
    return false; // Already here.
  } catch {
    /* not present, restore it */
  }
  const file = client().bucket(config.gcsBucket!).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const [contents] = await file.download();
  await fsp.writeFile(dest, contents);
  return true;
}

/**
 * Restore just the meeting index at boot -- one small meta.json per meeting.
 *
 * Cloud Run scales to zero, so the disk is empty on every cold start and this
 * runs every time. Pulling every document for every meeting would therefore get
 * slower with each meeting ever recorded, and leave the history looking empty
 * for the first minute after the app wakes up. The index is a few hundred bytes
 * a meeting; everything else is fetched on demand when a meeting is opened.
 */
export async function restoreIndex(meetingsRoot: string): Promise<number> {
  if (!config.gcsBucket) return 0;

  const [files] = await client()
    .bucket(config.gcsBucket)
    .getFiles({ prefix: 'meetings/', matchGlob: '**/meta.json' });

  const results = await Promise.all(
    files.map(async (file) => {
      const match = /^meetings\/([^/]+)\/meta\.json$/.exec(file.name);
      if (!match) return false;
      const meetingId = match[1]!;
      return download(file.name, path.join(meetingsRoot, meetingId, 'meta.json'));
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * Fetch one meeting's documents, for when it is actually opened. Cheap to call
 * repeatedly -- anything already on disk is skipped.
 */
export async function restoreMeeting(meetingId: string, dir: string): Promise<number> {
  if (!config.gcsBucket) return 0;
  const results = await Promise.all(
    ARCHIVED.map((name) =>
      download(`meetings/${meetingId}/${name}`, path.join(dir, name)),
    ),
  );
  return results.filter(Boolean).length;
}
