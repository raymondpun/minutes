/**
 * Pipeline logic tests with the model stubbed out.
 *
 * These do not test the prompts -- nothing here can tell you whether Gemini
 * honours "write 口語, never 書面語", and only a real recording can. What they
 * do test is everything that happens to the model's output afterwards, which
 * until now could only run during an actual meeting: shifting segment
 * timestamps across an 8-minute boundary, de-duplicating the overlap, carrying
 * speaker labels forward, refusing a hallucinated speaker, and deciding whether
 * the result is confident enough to draft without stopping to ask.
 */
process.env.GOOGLE_CLOUD_PROJECT ??= 'pipeline-test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-pipeline-'));
process.env.DATA_DIR = DATA;

const { __setGeneratorForTests } = await import('../dist/gemini.js');
const { buildTranscript } = await import('../dist/pipeline/transcribe.js');
const { identifySpeakers, applySpeakerNames } = await import('../dist/pipeline/identify.js');
const { draftMinutes } = await import('../dist/pipeline/minutes.js');
const store = await import('../dist/store.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Queue canned responses, and record what the pipeline asked for. */
function stub(responses) {
  const calls = [];
  let i = 0;
  __setGeneratorForTests(async (opts) => {
    calls.push(opts);
    const next = responses[Math.min(i++, responses.length - 1)];
    return typeof next === 'function' ? next(opts, calls.length - 1) : JSON.stringify(next);
  });
  return calls;
}

async function seedAudio(id, seconds) {
  await store.createMeeting({
    title: 'T',
    body: '',
    location: '',
    date: '2026-08-02',
    expectedAttendees: [],
    apologies: [],
    agenda: [],
    pauses: [],
  });
  // createMeeting generates its own id, so write straight into the given one.
  fs.mkdirSync(path.join(DATA, 'meetings', id), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'meetings', id, 'meta.json'),
    JSON.stringify({ id, status: 'setup', createdAt: new Date().toISOString(), pauses: [] }),
  );
  fs.writeFileSync(
    path.join(DATA, 'meetings', id, 'audio.pcm'),
    Buffer.alloc(seconds * 32_000),
  );
}

try {
  /* ------------------------------------- segmented transcription stitching - */

  console.log('\n1. Segmented transcription (no GCS bucket)');
  {
    const id = '2026-08-02-seg00001';
    // 17 minutes forces three 8-minute segments with 10s overlap.
    await seedAudio(id, 17 * 60);

    // Each segment reports times relative to ITSELF, starting at 0. The
    // pipeline has to shift them into meeting time -- getting this wrong is
    // how every quote ends up pointing at the first eight minutes.
    const calls = stub([
      { segments: [
        { start: 5, end: 9, speaker: 'Speaker 1', text: '我係 Raymond' },
        { start: 470, end: 474, speaker: 'Speaker 2', text: '個 budget approve 咗' },
      ] },
      { segments: [
        // Repeats the overlap, then new content.
        { start: 0, end: 4, speaker: 'Speaker 2', text: '個 budget approve 咗' },
        { start: 100, end: 104, speaker: 'Speaker 3', text: 'Peter here' },
      ] },
      { segments: [{ start: 30, end: 34, speaker: 'Speaker 1', text: '散會' }] },
    ]);

    const segments = await buildTranscript(id, [], () => {});

    check('one model call per segment', calls.length === 3, `${calls.length} calls`);
    check(
      'timestamps shifted into meeting time',
      segments.some((s) => Math.abs(s.start - 5) < 1) &&
        segments.some((s) => s.start > 500),
      segments.map((s) => Math.round(s.start)).join(', '),
    );
    check(
      'overlap de-duplicated',
      segments.filter((s) => s.text === '個 budget approve 咗').length === 1,
    );
    check('output sorted by time', segments.every((s, i, a) => i === 0 || a[i - 1].start <= s.start));
    check(
      'known speakers carried into later segments',
      String(calls[1].parts.at(-1).text).includes('Speaker 1') &&
        String(calls[1].parts.at(-1).text).includes('Speaker 2'),
    );
    check(
      'only the first segment is told it is the start',
      String(calls[0].parts.at(-1).text).includes('START of the meeting') &&
        !String(calls[1].parts.at(-1).text).includes('START of the meeting'),
    );
  }

  console.log('\n2. Empty and malformed model output');
  {
    const id = '2026-08-02-seg00002';
    await seedAudio(id, 60);
    stub([{ segments: [
      { start: 1, end: 2, speaker: 'Speaker 1', text: '  ' },
      { start: 3, end: 4, speaker: '', text: 'no speaker given' },
      { start: -5, end: 2, speaker: 'Speaker 1', text: 'negative start' },
    ] }]);
    const segments = await buildTranscript(id, [], () => {});
    check('blank text dropped', !segments.some((s) => s.text.trim() === ''));
    check('missing speaker defaulted', segments.some((s) => s.speaker === 'Speaker 1'));
    check('negative timestamps clamped', segments.every((s) => s.start >= 0));
  }

  /* ------------------------------------------------ speaker identification - */

  console.log('\n3. Speaker identification');
  {
    const transcript = [
      { start: 10, end: 14, speaker: 'Speaker 1', text: '我係 Raymond' },
      { start: 15, end: 19, speaker: 'Speaker 2', text: '我係 Cheryl' },
      { start: 600, end: 604, speaker: 'Speaker 2', text: '個 forecast 遲咗' },
      { start: 900, end: 904, speaker: 'Speaker 3', text: '同意' },
    ];

    stub([{ speakers: [
      { speakerId: 'Speaker 1', name: 'Raymond Pun', confidence: 'high', evidence: '我係 Raymond', evidenceTime: 10 },
      { speakerId: 'Speaker 2', name: 'Cheryl Lau', confidence: 'high', evidence: '我係 Cheryl', evidenceTime: 15 },
      { speakerId: 'Speaker 3', name: null, confidence: 'low', evidence: null, evidenceTime: null },
      // A speaker the transcript never contained.
      { speakerId: 'Speaker 9', name: 'Ghost', confidence: 'high', evidence: 'x', evidenceTime: 1 },
    ] }]);

    const speakers = await identifySpeakers(transcript, [], 20);

    check('one entry per real speaker', speakers.length === 3, `${speakers.length}`);
    check(
      'hallucinated speaker rejected',
      !speakers.some((s) => s.speakerId === 'Speaker 9'),
    );
    check(
      'turn counts computed from the transcript',
      speakers.find((s) => s.speakerId === 'Speaker 2').segmentCount === 2,
    );
    check(
      'unidentified speaker kept as null, not guessed',
      speakers.find((s) => s.speakerId === 'Speaker 3').name === null,
    );
    check('speakers ordered numerically', speakers.map((s) => s.speakerId).join() === 'Speaker 1,Speaker 2,Speaker 3');

    const named = applySpeakerNames(transcript, speakers);
    check('names applied across the whole transcript', named[2].speaker === 'Cheryl Lau');
    check('unnamed speaker keeps its label', named[3].speaker === 'Speaker 3');
  }

  /* -------------------------------------------------------- minutes backfill */

  console.log('\n4. Minutes backfill and review flags');
  {
    const speakers = [
      { speakerId: 'Speaker 1', name: 'Raymond Pun', confidence: 'high', segmentCount: 40 },
      { speakerId: 'Speaker 2', name: 'Guessed Name', confidence: 'low', evidence: 'maybe', segmentCount: 12 },
      { speakerId: 'Speaker 3', name: null, confidence: 'low', segmentCount: 7 },
    ];

    // A model response that omits half the header and leaves gaps a human
    // must close before signing.
    stub([{
      bodyName: '',
      title: '',
      date: '',
      location: '',
      present: [],
      items: [{
        number: '1',
        heading: 'Budget',
        discussion: 'Discussed.',
        resolutions: [],
        motions: [{ text: 'That it be approved', outcome: 'unclear', confidence: 'low' }],
        actions: [{ owner: 'Unassigned', action: 'Chase the vendor', dueDate: null, confidence: 'low' }],
        evidence: [],
      }],
      flaggedForReview: [],
    }]);

    const meta = {
      id: 'x', title: 'Q3 Board Meeting', body: 'Board of Directors',
      location: 'Boardroom', date: '2026-08-02', startedAt: '14:00', endedAt: '15:00',
      chair: 'Raymond Pun', expectedAttendees: [], apologies: ['Anna Chan'],
      agenda: [], pauses: [], status: 'drafting', createdAt: '',
    };

    const minutes = await draftMinutes(meta, [{ start: 0, end: 1, speaker: 'Raymond Pun', text: 'x' }], speakers);

    check('missing body name backfilled from meta', minutes.bodyName === 'Board of Directors');
    check('missing title backfilled', minutes.title === 'Q3 Board Meeting');
    check('missing times backfilled', minutes.startTime === '14:00' && minutes.endTime === '15:00');
    check('apologies backfilled', minutes.apologies.join() === 'Anna Chan');
    check(
      'present derived from identified speakers',
      minutes.present.join() === 'Raymond Pun,Guessed Name',
      minutes.present.join(),
    );

    const flags = minutes.flaggedForReview.join(' | ');
    check('unidentified speaker flagged', /Speaker 3 was never identified/.test(flags));
    check('low-confidence name flagged', /low confidence/.test(flags));
    check('unowned action flagged', /no named owner/.test(flags));
    check('undated action flagged', /no due date/.test(flags));
    check('unclear motion flagged', /outcome of motion/.test(flags));
    check('high-confidence speaker NOT flagged', !/Raymond Pun.*low confidence/.test(flags));
  }

  console.log('\n5. Refusing to draft from nothing');
  {
    stub([{}]);
    let threw = false;
    try {
      await draftMinutes({ id: 'x', pauses: [] }, [], []);
    } catch {
      threw = true;
    }
    check('empty transcript rejected rather than invented', threw);
  }
} catch (err) {
  console.error('\nFATAL', err);
  failures++;
} finally {
  __setGeneratorForTests(undefined);
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
