import { config } from '../config.js';
import { audioPart, generate } from '../gemini.js';
import { liveTranscriptPrompt } from '../prompts.js';
import { pcmToWav } from '../wav.js';

/**
 * Best-effort transcription of a single ~20s chunk while the meeting is running.
 *
 * This is deliberately the throwaway path. Its job is to prove on screen that
 * the mic is picking everyone up -- if the person at the far end of the table
 * never appears here, you can move the phone before you have wasted the whole
 * meeting. The transcript that ends up in the minutes is produced later from the
 * complete recording, where the model has full context.
 */
export async function transcribeChunk(
  pcm: Buffer,
  tail: string,
): Promise<string> {
  const wav = pcmToWav(pcm);

  const text = await generate({
    model: config.models.live,
    label: 'live-chunk',
    parts: [
      audioPart({ bytes: wav, mimeType: 'audio/wav' }),
      { text: liveTranscriptPrompt(tail) },
    ],
    // A 60s chunk of speech is a few hundred tokens of words; 4096 is
    // headroom, not a target. thinkingBudget 0 matters more: thinking shares
    // this budget, and left uncapped it ate the whole 2048 on roughly half of
    // all chunks -- each one a minute of meeting silently missing on screen.
    maxOutputTokens: 4_096,
    thinkingBudget: 0,
  });

  return text.trim();
}
