import { config } from '../config.js';
import { generateJson } from '../gemini.js';
import { ROLL_CALL_SCHEMA, rollCallPrompt } from '../prompts.js';

export interface RollCallCheck {
  finished: boolean;
  namesHeard: string[];
  reason: string;
}

/**
 * Decide whether the round of introductions has finished.
 *
 * Runs on the live transcript while the meeting is in its roll-call phase, so
 * the app can move on by itself. The chair is talking to people, not watching a
 * screen -- asking them to press a button to say "we've finished introducing
 * ourselves" is asking them to operate an app during the one moment they are
 * most obviously busy.
 *
 * Text-only and tiny, so it costs a fraction of a cent per meeting.
 */
export async function checkRollCall(
  text: string,
  expectedAttendees: string[],
): Promise<RollCallCheck> {
  const result = await generateJson<RollCallCheck>({
    model: config.models.digest,
    label: 'roll-call-check',
    parts: [{ text: rollCallPrompt(text, expectedAttendees) }],
    responseSchema: ROLL_CALL_SCHEMA,
    maxOutputTokens: 1_024,
    // 1024 tokens is the tightest budget in the app; uncapped thinking would
    // blow it and the roll call would never be detected as finished.
    thinkingBudget: 0,
  });

  return {
    finished: Boolean(result.finished),
    namesHeard: (result.namesHeard ?? []).map((n) => n.trim()).filter(Boolean),
    reason: result.reason ?? '',
  };
}
