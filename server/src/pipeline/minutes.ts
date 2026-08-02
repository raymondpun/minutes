import { config } from '../config.js';
import { generateJson } from '../gemini.js';
import { MINUTES_SCHEMA, minutesPrompt } from '../prompts.js';
import type {
  MeetingMeta,
  Minutes,
  SpeakerIdentification,
  TranscriptSegment,
} from '../types.js';

export async function draftMinutes(
  meta: MeetingMeta,
  transcript: TranscriptSegment[],
  speakers: SpeakerIdentification[],
): Promise<Minutes> {
  if (transcript.length === 0) {
    throw new Error('Cannot draft minutes: the transcript is empty.');
  }

  const minutes = await generateJson<Minutes>({
    model: config.models.minutes,
    label: 'draft-minutes',
    parts: [{ text: minutesPrompt({ meta, transcript, speakers }) }],
    responseSchema: MINUTES_SCHEMA,
    maxOutputTokens: 65_536,
  });

  return backfill(minutes, meta, speakers);
}

/**
 * The model occasionally omits a nullable field or drops a header value it was
 * given. Fill those from meta rather than shipping a document with holes, and
 * make sure every unidentified speaker produces a review flag even if the model
 * forgot to raise one.
 */
function backfill(
  minutes: Minutes,
  meta: MeetingMeta,
  speakers: SpeakerIdentification[],
): Minutes {
  const flags = new Set(minutes.flaggedForReview ?? []);

  for (const s of speakers) {
    if (!s.name) {
      flags.add(
        `${s.speakerId} was never identified (${s.segmentCount} contributions). Add their name before sign-off.`,
      );
    } else if (s.confidence === 'low') {
      flags.add(
        `Speaker name "${s.name}" was inferred with low confidence${
          s.evidence ? ` from: "${s.evidence}"` : ''
        }. Verify before sign-off.`,
      );
    }
  }

  for (const item of minutes.items ?? []) {
    for (const action of item.actions ?? []) {
      if (action.owner === 'Unassigned' || !action.owner) {
        flags.add(`Item ${item.number}: action "${action.action}" has no named owner.`);
      }
      if (!action.dueDate) {
        flags.add(`Item ${item.number}: action "${action.action}" has no due date.`);
      }
    }
    for (const motion of item.motions ?? []) {
      if (motion.outcome === 'unclear') {
        flags.add(`Item ${item.number}: the outcome of motion "${motion.text}" was unclear.`);
      }
    }
  }

  return {
    ...minutes,
    bodyName: minutes.bodyName || meta.body || meta.title,
    title: minutes.title || meta.title,
    date: minutes.date || meta.date,
    location: minutes.location || meta.location,
    startTime: minutes.startTime ?? meta.startedAt ?? null,
    endTime: minutes.endTime ?? meta.endedAt ?? null,
    chair: minutes.chair ?? meta.chair ?? null,
    secretary: minutes.secretary ?? meta.secretary ?? null,
    present: minutes.present?.length
      ? minutes.present
      : speakers.filter((s) => s.name).map((s) => s.name!),
    inAttendance: minutes.inAttendance ?? [],
    apologies: minutes.apologies?.length ? minutes.apologies : meta.apologies,
    items: minutes.items ?? [],
    flaggedForReview: [...flags],
    nextMeeting: minutes.nextMeeting ?? null,
  };
}

/* -------------------------------------------------------------- rendering --- */

export function renderMarkdown(minutes: Minutes): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);

  p(`# ${minutes.bodyName}`);
  p();
  p(`## Minutes of the ${minutes.title}`);
  p();
  p(`**Date:** ${formatDate(minutes.date)}  `);
  if (minutes.startTime) {
    p(
      `**Time:** ${minutes.startTime}${minutes.endTime ? ` – ${minutes.endTime}` : ''}  `,
    );
  }
  p(`**Location:** ${minutes.location || 'Not recorded'}  `);
  if (minutes.chair) p(`**Chair:** ${minutes.chair}  `);
  if (minutes.secretary) p(`**Secretary:** ${minutes.secretary}  `);
  p();

  p(`**Present:** ${list(minutes.present)}`);
  p();
  if (minutes.inAttendance?.length) {
    p(`**In attendance:** ${list(minutes.inAttendance)}`);
    p();
  }
  if (minutes.apologies?.length) {
    p(`**Apologies for absence:** ${list(minutes.apologies)}`);
    p();
  }

  p('---');
  p();

  for (const item of minutes.items) {
    p(`### ${item.number}. ${item.heading}`);
    p();
    if (item.discussion) {
      p(item.discussion);
      p();
    }

    for (const motion of item.motions ?? []) {
      const parts: string[] = [];
      if (motion.proposedBy) parts.push(`proposed by ${motion.proposedBy}`);
      if (motion.secondedBy) parts.push(`seconded by ${motion.secondedBy}`);
      p(`> **Motion:** ${motion.text}`);
      if (parts.length) p(`> *${capitalise(parts.join(', '))}.*`);
      const votes = [
        motion.votesFor != null ? `${motion.votesFor} for` : null,
        motion.votesAgainst != null ? `${motion.votesAgainst} against` : null,
        motion.abstentions != null ? `${motion.abstentions} abstaining` : null,
      ].filter(Boolean);
      p(
        `> **Outcome:** ${capitalise(motion.outcome)}${votes.length ? ` (${votes.join(', ')})` : ''}${flag(motion.confidence)}`,
      );
      if (motion.evidence) p(`> ${cite(motion.evidence.time, motion.evidence.quote)}`);
      p();
    }

    for (const resolution of item.resolutions ?? []) {
      p(`**RESOLVED THAT** ${stripResolved(resolution)}`);
      p();
    }

    if (item.actions?.length) {
      p('| Action | Owner | By when |');
      p('| --- | --- | --- |');
      for (const a of item.actions) {
        p(
          `| ${escapeCell(a.action)}${flag(a.confidence)} | ${escapeCell(a.owner)} | ${escapeCell(a.dueDate ?? '—')} |`,
        );
      }
      p();
    }

    const cites = [
      ...(item.evidence ?? []),
      ...(item.actions ?? []).map((a) => a.evidence).filter(Boolean),
    ].filter(Boolean) as Array<{ time: number; quote: string }>;
    if (cites.length) {
      p('<details><summary>Source — what was actually said</summary>');
      p();
      for (const e of cites) p(`- ${cite(e.time, e.quote)}`);
      p();
      p('</details>');
      p();
    }
  }

  if (minutes.nextMeeting) {
    p(`### Date of next meeting`);
    p();
    p(minutes.nextMeeting);
    p();
  }

  if (minutes.flaggedForReview?.length) {
    p('---');
    p();
    p('## ⚠️ To verify before sign-off');
    p();
    p(
      '_These minutes were drafted from an audio recording by an automated system. ' +
        'The following points could not be established with confidence and must be ' +
        'checked by the secretary before the minutes are tabled._',
    );
    p();
    for (const f of minutes.flaggedForReview) p(`- [ ] ${f}`);
    p();
  }

  p('---');
  p();
  p(
    `_Drafted automatically from the meeting recording on ${new Date().toISOString().slice(0, 10)}. ` +
      'Quotations are verbatim in the language spoken; the body of the minutes is a translation. ' +
      'Not a signed record until approved._',
  );
  p();

  return out.join('\n');
}

function cite(time: number, quote: string): string {
  return `\`[${timestamp(time)}]\` “${quote}”`;
}

function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function flag(confidence: 'high' | 'medium' | 'low'): string {
  return confidence === 'low' ? ' **[TO VERIFY]**' : '';
}

function stripResolved(text: string): string {
  return text.replace(/^\s*resolved\s+that\s+/i, '');
}

function list(names: string[]): string {
  return names.length ? names.join(', ') : 'Not recorded';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
