import { config } from '../config.js';
import { generateJson } from '../gemini.js';
import { DIGEST_SCHEMA, digestPrompt } from '../prompts.js';
import type { DigestBlock } from '../types.js';

type RawDigest = Omit<DigestBlock, 'start' | 'end'>;

/**
 * Fold the last few minutes of live transcript into one summary block.
 *
 * Append-only by design: each block covers a fixed window and is never
 * rewritten. Re-summarising the whole meeting every few minutes would cost
 * quadratically and, worse, would let a later block quietly rewrite what an
 * earlier one said -- which is the opposite of what you want from something
 * people are reading back during the meeting.
 */
export async function buildDigest(args: {
  text: string;
  recentHeadings: string[];
  fromSeconds: number;
  toSeconds: number;
}): Promise<DigestBlock> {
  const result = await generateJson<RawDigest>({
    model: config.models.digest,
    label: `digest-${Math.round(args.fromSeconds)}s`,
    parts: [{ text: digestPrompt(args) }],
    responseSchema: DIGEST_SCHEMA,
    maxOutputTokens: 2_048,
  });

  return {
    start: args.fromSeconds,
    end: args.toSeconds,
    heading: result.heading?.trim() || 'Discussion',
    bullets: (result.bullets ?? []).map((b) => b.trim()).filter(Boolean),
    decisions: (result.decisions ?? []).map((d) => d.trim()).filter(Boolean),
    continuesPrevious: Boolean(result.continuesPrevious),
  };
}
