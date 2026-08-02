import fsp from 'node:fs/promises';
import path from 'node:path';
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

/**
 * Pull back any archived meetings this instance has never seen. Runs at boot,
 * so a cold start after a week of inactivity still shows the meeting history.
 */
export async function restoreArchive(meetingsRoot: string): Promise<number> {
  if (!config.gcsBucket) return 0;

  const [files] = await client()
    .bucket(config.gcsBucket)
    .getFiles({ prefix: 'meetings/' });

  let restored = 0;
  for (const file of files) {
    const match = /^meetings\/([^/]+)\/([^/]+)$/.exec(file.name);
    if (!match) continue;
    const [, meetingId, name] = match as unknown as [string, string, string];
    if (!(ARCHIVED as readonly string[]).includes(name)) continue;

    const destDir = path.join(meetingsRoot, meetingId);
    const dest = path.join(destDir, name);
    try {
      await fsp.access(dest);
      continue; // Already here.
    } catch {
      /* not present, restore it */
    }
    await fsp.mkdir(destDir, { recursive: true });
    const [contents] = await file.download();
    await fsp.writeFile(dest, contents);
    restored++;
  }
  return restored;
}
