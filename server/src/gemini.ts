import { GoogleGenAI } from '@google/genai';
import type { Part } from '@google/genai';
import { config } from './config.js';

/**
 * Vertex-backed Gemini client. Auth comes from Application Default Credentials:
 * `gcloud auth application-default login` locally, the attached service account
 * on Cloud Run. No API keys anywhere.
 */
export const ai = new GoogleGenAI({
  vertexai: true,
  project: config.projectId,
  location: config.location,
});

export interface AudioRef {
  /** Either inline bytes or a gs:// URI, never both. */
  bytes?: Buffer;
  gcsUri?: string;
  mimeType: string;
}

export function audioPart(ref: AudioRef): Part {
  if (ref.gcsUri) {
    return { fileData: { fileUri: ref.gcsUri, mimeType: ref.mimeType } };
  }
  if (!ref.bytes) throw new Error('audioPart needs either bytes or a gcsUri');
  return {
    inlineData: { mimeType: ref.mimeType, data: ref.bytes.toString('base64') },
  };
}

interface GenerateOptions {
  model: string;
  parts: Part[];
  systemInstruction?: string;
  /** Supplying a schema forces valid JSON back, so we never parse prose. */
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  /** Label used in logs so you can tell which stage was slow or failed. */
  label: string;
}

const RETRYABLE = /429|500|502|503|504|deadline|unavailable|overloaded|timeout/i;

export async function generate(opts: GenerateOptions): Promise<string> {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: [{ role: 'user', parts: opts.parts }],
        config: {
          // Minutes are a record, not a creative writing exercise. Any
          // temperature above zero is the model inventing variety we don't want.
          temperature: opts.temperature ?? 0,
          maxOutputTokens: opts.maxOutputTokens ?? 32_768,
          ...(opts.systemInstruction
            ? { systemInstruction: opts.systemInstruction }
            : {}),
          ...(opts.responseSchema
            ? {
                responseMimeType: 'application/json',
                responseSchema: opts.responseSchema as never,
              }
            : {}),
        },
      });

      const text = response.text;
      if (!text) {
        // An empty body with a finishReason is usually a safety block or a
        // token cap, and retrying identical input will not help.
        const reason = response.candidates?.[0]?.finishReason ?? 'unknown';
        throw new Error(`Empty response from ${opts.model} (finishReason=${reason})`);
      }

      console.log(`[gemini] ${opts.label} ok in ${Date.now() - started}ms`);
      return text;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = RETRYABLE.test(message) && attempt < maxAttempts;
      console.warn(
        `[gemini] ${opts.label} attempt ${attempt}/${maxAttempts} failed: ${message}`,
      );
      if (!retryable) break;
      // 2s, 4s, 8s.
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** (attempt - 1)));
    }
  }

  throw new Error(
    `${opts.label} failed after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function generateJson<T>(opts: GenerateOptions): Promise<T> {
  const raw = await generate(opts);
  try {
    return JSON.parse(raw) as T;
  } catch {
    // responseSchema makes this rare, but a truncated response is still possible
    // if the model hits maxOutputTokens mid-object.
    const start = raw.indexOf('{');
    const arrayStart = raw.indexOf('[');
    const from =
      arrayStart !== -1 && (start === -1 || arrayStart < start) ? arrayStart : start;
    if (from !== -1) {
      const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
      if (end > from) {
        try {
          return JSON.parse(raw.slice(from, end + 1)) as T;
        } catch {
          /* fall through */
        }
      }
    }
    throw new Error(
      `${opts.label} returned unparseable JSON (${raw.length} chars): ${raw.slice(0, 400)}`,
    );
  }
}
