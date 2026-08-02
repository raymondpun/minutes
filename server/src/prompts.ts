import type { MeetingMeta, SpeakerIdentification, TranscriptSegment } from './types.js';

/**
 * Shared language contract. Repeated into every stage because the failure mode
 * we care about most is the model silently "helpfully" translating Cantonese
 * into Mandarin-style 書面語 -- which destroys the transcript as evidence,
 * because it is no longer what anyone actually said.
 */
const LANGUAGE_RULES = `
LANGUAGE OF THIS MEETING
The speakers are Hong Kong professionals. They speak Cantonese and switch into
English mid-sentence, constantly. This is normal Hong Kong code-switching, not
an error, and you must preserve it exactly.

Transcription rules, in priority order:

1. WRITE CANTONESE AS SPOKEN CANTONESE (口語), in Traditional Chinese.
   Use 係 唔係 嘅 咗 喺 冇 嗰 呢 啲 佢 哋 乜嘢 點解 而家 得唔得 做緊.
   Do NOT convert to 書面語 / Mandarin forms: never write 是 不是 的 了 在 沒有
   那 這些 他們 什麼 為什麼 現在 when the speaker said the Cantonese form.
   This transcript is the evidence layer. It must be what was said.

2. KEEP ENGLISH IN ENGLISH, in Latin script.
   If someone says "我哋個 budget 已經 approve 咗", write exactly that.
   Never transliterate English into Chinese characters. Never translate English
   into Chinese. Never translate Cantonese into English at this stage.

3. Preserve Hong Kong business vocabulary as spoken: KPI, headcount, Q3,
   deadline, follow up, confirm, share, project, team, client, budget, board,
   AGM, EGM, HKD, and so on.

4. Numbers, dates and money: write as spoken. 三百萬 stays 三百萬 if said in
   Cantonese; "three million" stays English if said in English.

5. Do not clean up speech. Keep false starts and repetition where they carry
   meaning (hesitation before agreeing to a deadline matters). You may drop pure
   filler (呃, 即係 used as filler, um) when it adds nothing.

6. If a passage is genuinely inaudible, write [不清楚] and move on. Never guess
   at content you cannot hear. A gap is recoverable; an invented sentence is not.
`.trim();

const HONESTY_RULES = `
GROUNDING RULES -- these override any instinct to be helpful.

- Report only what is in the audio. If it was not said, it does not exist.
- Never infer a decision from a discussion. People discussing an option at
  length have not decided anything. Only record a decision where someone
  actually states, agrees to, or confirms it.
- Never invent an owner or a deadline for an action. If nobody was named,
  the owner is "Unassigned". If no date was given, the due date is null.
- Never invent attendee names, job titles, agenda numbering, or amounts.
- Where something matters but is ambiguous, record it and mark confidence
  "low", and add a note to flaggedForReview. An honest flag is far more useful
  than a confident guess.
- Silence is an acceptable answer. An empty list is an acceptable answer.
`.trim();

/* ------------------------------------------------------------------ live --- */

/**
 * Runs on every ~20s chunk while the meeting is happening. Rough by design:
 * it exists so the chair can see the mic is working and catch a speaker who
 * isn't being picked up. The authoritative transcript is the full-file pass.
 */
export function liveTranscriptPrompt(tail: string): string {
  return `
Transcribe this short audio clip from an ongoing meeting.

${LANGUAGE_RULES}

${
  tail
    ? `For context, the transcript immediately before this clip ended with:\n"""${tail}"""\nContinue naturally from there. Do not repeat it.`
    : 'This is the very beginning of the meeting.'
}

Output ONLY the transcribed words. No speaker labels, no timestamps, no
commentary, no markdown. If the clip contains no intelligible speech, output an
empty string.
`.trim();
}

/* ------------------------------------------------------------- roll call --- */

export function rollCallPrompt(text: string, expectedAttendees: string[]): string {
  return `
A meeting has just started. The chair asked everyone present to say their name
before business begins. Below is the rough live transcript of the opening.

Decide whether that round of introductions has FINISHED and the meeting proper
has started.

It has finished when people stop saying who they are and start discussing
something — an agenda item, apologies, last meeting's minutes, any actual topic.

It has NOT finished while people are still saying things like:
  "我係 Raymond", "Hi, I'm Cheryl", "Peter here, operations", "我叫陳大文",
  or the chair is still going round the table prompting people.

Be conservative in one direction only: it is much better to keep listening for
another twenty seconds than to cut the introductions off early and lose
somebody's name. If you are unsure, answer false.

A short pause, or the chair saying "OK" or "好", is not on its own the end.

namesHeard: every name you heard someone give for THEMSELVES, spelled as best
you can. Not names of people being talked about. Empty array if none yet.

reason: a handful of words on what decided it.
${expectedAttendees.length ? `\nExpected to attend: ${expectedAttendees.join(', ')}.` : ''}

TRANSCRIPT SO FAR
${text}
`.trim();
}

export const ROLL_CALL_SCHEMA = {
  type: 'object',
  properties: {
    finished: { type: 'boolean' },
    namesHeard: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['finished', 'namesHeard', 'reason'],
} as const;

/* ---------------------------------------------------------------- digest --- */

/**
 * Runs every few minutes during the meeting, over the transcript since the last
 * block. Produces the running summary the chair reads back in the room.
 *
 * The hard part is restraint. Half way through a discussion the model has heard
 * an argument but not its conclusion, and the temptation is to write down the
 * loudest opinion as though it were the outcome. A wrong running summary is
 * worse than none, because it is read during the meeting and acted on.
 */
export function digestPrompt(args: {
  text: string;
  recentHeadings: string[];
  fromSeconds: number;
  toSeconds: number;
}): string {
  const { text, recentHeadings, fromSeconds, toSeconds } = args;

  return `
Below is a rough live transcript of the last few minutes of a meeting in
progress (from ${formatClock(fromSeconds)} to ${formatClock(toSeconds)} of the
recording). It was transcribed in short chunks and is not fully accurate.

Summarise this window so someone in the room can glance back later and remember
what was covered.

WRITE THE SUMMARY IN ENGLISH, even though the meeting is in Cantonese mixed with
English. Keep names and terms as spoken.

${
  recentHeadings.length
    ? `The previous blocks were headed:
${recentHeadings.map((h) => `  - ${h}`).join('\n')}

If this window continues the SAME topic as the most recent heading, reuse that
heading exactly and set continuesPrevious to true. If the discussion has moved
on, write a new heading and set continuesPrevious to false.`
    : 'This is the first block of the meeting. Set continuesPrevious to false.'
}

heading: three to six words naming the topic. Concrete, not "Discussion" or
  "General Update". "Q3 revenue shortfall" or "Kwun Tong office lease".

bullets: two to four short points. What was said and by whom where a name was
  used. Positions taken, numbers quoted, questions raised. Past tense.

decisions: ONLY where someone actually stated, agreed to, or confirmed
  something in this window. This is the field you will be tempted to overfill.
  People discussing an option at length have decided nothing. An argument
  someone made is not a decision. If nobody concluded anything, return an empty
  array -- which is the normal case for most five minute windows of most
  meetings.

Never invent a name, a number, a date or an outcome. Where the transcript is
garbled, leave it out rather than guessing. This is a rough transcript and
over-reading it is the main risk.

TRANSCRIPT OF THIS WINDOW
${text}
`.trim();
}

export const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    heading: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    continuesPrevious: { type: 'boolean' },
  },
  required: ['heading', 'bullets', 'decisions', 'continuesPrevious'],
} as const;

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ------------------------------------------------------- full transcript --- */

export function diarizedTranscriptPrompt(args: {
  offsetSeconds: number;
  knownSpeakers: string[];
  expectedAttendees: string[];
  isFirstSegment: boolean;
}): string {
  const { offsetSeconds, knownSpeakers, expectedAttendees, isFirstSegment } = args;

  return `
You are producing the verbatim transcript of an in-person meeting recording,
with speaker diarization.

${LANGUAGE_RULES}

DIARIZATION
Separate the audio by speaker. ${
    knownSpeakers.length
      ? `Speakers already identified earlier in this meeting are:
${knownSpeakers.map((s) => `  - ${s}`).join('\n')}
Reuse those exact labels for the same voices. If you hear a voice that is
clearly none of them, label it "Speaker ${knownSpeakers.length + 1}", then
"Speaker ${knownSpeakers.length + 2}", and so on.`
      : 'Label speakers "Speaker 1", "Speaker 2", "Speaker 3" in the order they first speak.'
  }
${
    expectedAttendees.length
      ? `\nThese people were expected to attend, which may help you recognise names
when they are spoken aloud: ${expectedAttendees.join(', ')}.
Do NOT assign these names to speakers here -- use "Speaker N" labels only.
Name mapping happens in a later step.`
      : ''
  }
${
    isFirstSegment
      ? `\nThis is the START of the meeting. Attendees were asked to say their own
names at the beginning. Transcribe those introductions with particular care --
the exact spelling and form of each name matters, and both English names
("Raymond", "Cheryl") and Chinese names (陳大文) may be used, sometimes both
for the same person.`
      : ''
  }

TIMESTAMPS
Give start and end in SECONDS as decimals, measured from the beginning of THIS
audio clip (start at 0). Do not add any offset yourself.
${offsetSeconds > 0 ? `(The caller knows this clip begins at ${offsetSeconds.toFixed(1)}s of the full meeting and will adjust.)` : ''}

SEGMENTATION
Break at natural speech boundaries -- a change of speaker, or a complete thought.
Aim for segments of roughly one to three sentences. Do not emit one giant
segment, and do not split every few words.

For the "language" field: "yue" if the segment is essentially all Cantonese,
"en" if essentially all English, "mixed" if it code-switches, "other" otherwise.

${HONESTY_RULES}
`.trim();
}

export const TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          speaker: { type: 'string' },
          text: { type: 'string' },
          language: { type: 'string', enum: ['yue', 'en', 'mixed', 'other'] },
        },
        required: ['start', 'end', 'speaker', 'text'],
      },
    },
  },
  required: ['segments'],
} as const;

/* -------------------------------------------------- speaker identification --- */

export function identifySpeakersPrompt(args: {
  transcript: TranscriptSegment[];
  expectedAttendees: string[];
  rollCallEndedAt?: number;
}): string {
  const { transcript, expectedAttendees, rollCallEndedAt } = args;
  const lines = transcript
    .map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`)
    .join('\n');

  return `
Below is a diarized transcript of a Hong Kong business meeting, with speakers
labelled "Speaker 1", "Speaker 2" and so on.

At the start of the meeting the attendees were asked to say their own names.
Your job is to map each speaker label to a real person's name.

${
    rollCallEndedAt
      ? `THE ROLL CALL IS BETWEEN 0s AND ${rollCallEndedAt.toFixed(0)}s.
The chair ran an explicit round of introductions there before the meeting
proper began. That stretch is your primary evidence -- work through it first
and map every voice you can before looking anywhere else.\n`
      : ''
}
HOW TO DO THIS
1. Look first at the opening minutes for self-introductions:
   "我係 Raymond", "Hi, I'm Cheryl", "我叫陳大文", "Peter here".
   The person who says "我係 X" is Speaker X's owner -- match the name to the
   label of the person who SPOKE it, not to whoever is mentioned.
2. Then use the rest of the transcript. People address each other by name
   constantly ("Raymond 你覺得點?"). If Speaker 2 is addressed as Raymond and
   then answers, Speaker 2 is Raymond. Watch the direction carefully: being
   named is not the same as speaking.
3. The chair usually opens the meeting and runs the agenda. That is a useful
   signal but not proof.

${
  expectedAttendees.length
    ? `The expected attendee list is: ${expectedAttendees.join(', ')}.
Prefer these spellings when a spoken name plainly matches one of them --
"Raymond" heard in audio should map to "Raymond Pun" if that is on the list.
But do NOT force every speaker onto this list, and do NOT assume everyone on
the list attended. People miss meetings, and strangers turn up.`
    : 'No attendee list was provided, so rely entirely on what is spoken.'
}

RULES
- If a speaker never introduces themselves and is never addressed by name,
  set name to null. Do not guess from voice, seniority, or how much they talk.
  An unnamed speaker is a normal outcome -- someone arrived late, or stayed quiet
  during introductions.
- confidence "high" means they clearly stated their own name, or were addressed
  by name repeatedly and unambiguously.
  "medium" means one reasonable but single piece of evidence.
  "low" means you are inferring. Prefer null over a low-confidence guess where
  the name would end up attached to a formal resolution.
- evidence must be the VERBATIM quote that justified the mapping, in the original
  language exactly as it appears in the transcript, with its timestamp.
- role only if a job title was actually stated aloud.

TRANSCRIPT
${lines}
`.trim();
}

export const SPEAKERS_SCHEMA = {
  type: 'object',
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speakerId: { type: 'string' },
          name: { type: 'string', nullable: true },
          role: { type: 'string', nullable: true },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string', nullable: true },
          evidenceTime: { type: 'number', nullable: true },
        },
        required: ['speakerId', 'confidence'],
      },
    },
  },
  required: ['speakers'],
} as const;

/* --------------------------------------------------------------- minutes --- */

export function minutesPrompt(args: {
  meta: MeetingMeta;
  transcript: TranscriptSegment[];
  speakers: SpeakerIdentification[];
}): string {
  const { meta, transcript, speakers } = args;

  const roster = speakers
    .map(
      (s) =>
        `  ${s.speakerId} = ${s.name ?? 'UNIDENTIFIED'}${s.role ? ` (${s.role})` : ''}`,
    )
    .join('\n');

  const body = transcript
    .map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`)
    .join('\n');

  return `
You are an experienced company secretary drafting the FORMAL MINUTES of the
meeting transcribed below. These minutes are a document of record. They may be
tabled for approval at the next meeting, relied on later to establish what was
agreed, and read by people who were not in the room.

MEETING DETAILS (use these, do not invent alternatives)
  Body:      ${meta.body || meta.title}
  Title:     ${meta.title}
  Date:      ${meta.date}
  Location:  ${meta.location || 'Not recorded'}
  Started:   ${meta.startedAt ?? 'Not recorded'}
  Ended:     ${meta.endedAt ?? 'Not recorded'}
  Chair:     ${meta.chair || 'Determine from the transcript, else null'}
  Secretary: ${meta.secretary || 'null unless stated in the transcript'}
${meta.apologies.length ? `  Apologies notified in advance: ${meta.apologies.join(', ')}` : ''}
${
  meta.agenda.length
    ? `\nAGENDA SUPPLIED BY THE CHAIR (structure the minutes around this where the
discussion matches, but add items for anything substantive that was discussed
off-agenda, and omit agenda items that were never reached):
${meta.agenda.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}`
    : '\nNo agenda was supplied. Derive the item structure from the discussion itself.'
}

SPEAKER ROSTER
${roster || '  (none identified)'}
Use real names throughout the minutes. Where a speaker is UNIDENTIFIED, write
"An unidentified attendee" rather than "Speaker 3", and add a flaggedForReview
note so the secretary can fill in the name.

LANGUAGE OF THE MINUTES
The meeting was conducted in Cantonese mixed with English. THE MINUTES MUST BE
WRITTEN IN FORMAL BUSINESS ENGLISH. You are translating as you draft.

  - Translate the substance faithfully. Do not soften a disagreement, do not
    upgrade a "maybe" into a commitment, and do not resolve an ambiguity that
    the speakers left open. If the Cantonese was hedged, the English must be
    hedged.
  - Keep terms that Hong Kong business English keeps in English anyway
    (KPI, headcount, Q3, AGM, HKD).
  - Convert money and dates to a consistent formal form: HK$3,000,000 and
    31 December 2026.
  - EVERY evidence quote must remain in the ORIGINAL language, verbatim, in 口語
    Cantonese exactly as it appears in the transcript. Never translate a quote.
    The quote is what lets a reader verify your translation was fair.

HOUSE STYLE FOR FORMAL MINUTES
  - Third person, past tense, reported speech throughout.
    "The Finance Director reported that..." not "Ray said we should..."
  - No direct address, no "we", no "I", no contractions.
  - Refer to people by name and, on first use in an item, their role if known.
  - Minute discussion at the level of substance and reasoning, not turn by turn.
    Two people going back and forth for ten minutes becomes one paragraph that
    records the positions taken and why.
  - Record disagreement where it occurred. Minutes that read as though everyone
    always agreed are not accurate minutes.
  - Number items 1, 2, 3 at top level and 4.1, 4.2 for sub-items.
  - Resolutions in the conventional form:
      "RESOLVED THAT the budget of HK$3,000,000 for the Q4 campaign be approved."
  - Where a formal motion was proposed and seconded, capture it as a motion with
    proposer, seconder, outcome and the vote count if one was taken. Most
    discussion is NOT a formal motion -- only record one where the transcript
    actually shows a motion being put.
  - Actions as owner + what + by when. Owner must be a named person from the
    roster, or "Unassigned".

STANDARD OPENING ITEMS -- include each ONLY if the transcript shows it happened:
  Welcome and apologies for absence; declarations of interest; approval of the
  minutes of the previous meeting; matters arising. Do not manufacture these
  because minutes usually have them. Most working meetings have none of them.
Likewise, include "Any Other Business" and "Date of Next Meeting" only if raised.

${HONESTY_RULES}

Populate flaggedForReview with anything the secretary must check before signing
off: unidentified speakers, an amount or date you could not hear clearly, an
action with no owner, a decision that sounded provisional, or a passage marked
[不清楚] that seemed important.

TRANSCRIPT
${body}
`.trim();
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  nullable: true,
  properties: {
    time: { type: 'number' },
    quote: { type: 'string' },
  },
  required: ['time', 'quote'],
} as const;

export const MINUTES_SCHEMA = {
  type: 'object',
  properties: {
    bodyName: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string' },
    startTime: { type: 'string', nullable: true },
    endTime: { type: 'string', nullable: true },
    location: { type: 'string' },
    chair: { type: 'string', nullable: true },
    secretary: { type: 'string', nullable: true },
    present: { type: 'array', items: { type: 'string' } },
    inAttendance: { type: 'array', items: { type: 'string' } },
    apologies: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          heading: { type: 'string' },
          discussion: { type: 'string' },
          resolutions: { type: 'array', items: { type: 'string' } },
          motions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                proposedBy: { type: 'string', nullable: true },
                secondedBy: { type: 'string', nullable: true },
                outcome: {
                  type: 'string',
                  enum: [
                    'carried',
                    'carried unanimously',
                    'defeated',
                    'withdrawn',
                    'deferred',
                    'unclear',
                  ],
                },
                votesFor: { type: 'number', nullable: true },
                votesAgainst: { type: 'number', nullable: true },
                abstentions: { type: 'number', nullable: true },
                evidence: EVIDENCE_SCHEMA,
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['text', 'outcome', 'confidence'],
            },
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                action: { type: 'string' },
                dueDate: { type: 'string', nullable: true },
                evidence: EVIDENCE_SCHEMA,
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['owner', 'action', 'confidence'],
            },
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'number' },
                quote: { type: 'string' },
              },
              required: ['time', 'quote'],
            },
          },
        },
        required: ['number', 'heading', 'discussion', 'resolutions', 'motions', 'actions'],
      },
    },
    flaggedForReview: { type: 'array', items: { type: 'string' } },
    nextMeeting: { type: 'string', nullable: true },
  },
  required: ['bodyName', 'title', 'date', 'location', 'present', 'items', 'flaggedForReview'],
} as const;
