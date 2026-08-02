import { Storage } from '@google-cloud/storage';
import { config } from './config.js';

let storage: Storage | undefined;

function client(): Storage {
  storage ??= new Storage({ projectId: config.projectId });
  return storage;
}

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

/** Called once minutes are drafted -- the recording should not outlive its purpose. */
export async function deleteAudio(meetingId: string): Promise<void> {
  if (!config.gcsBucket) return;
  await client()
    .bucket(config.gcsBucket)
    .file(`meetings/${meetingId}/audio.wav`)
    .delete({ ignoreNotFound: true });
}
