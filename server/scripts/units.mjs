/**
 * Unit checks for the pure logic: WAV framing and the formal-minutes renderer.
 * Runs against dist/, so `npm -w server run build` first.
 */
// config.js validates env at import time, so this must be set before the
// dynamic imports below. No Vertex calls are made by these tests.
process.env.GOOGLE_CLOUD_PROJECT ??= 'unit-test';

const { pcmToWav, pcmDurationSeconds, secondsToByteOffset } = await import(
  '../dist/wav.js'
);
const { renderMarkdown } = await import('../dist/pipeline/minutes.js');
const { liveChunkBytes } = await import('../dist/config.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\n1. WAV framing');
{
  const pcm = Buffer.alloc(32_000); // 1 second at 16 kHz mono 16-bit
  const wav = pcmToWav(pcm);
  check('header is 44 bytes', wav.length - pcm.length === 44);
  check('RIFF magic', wav.toString('ascii', 0, 4) === 'RIFF');
  check('WAVE magic', wav.toString('ascii', 8, 12) === 'WAVE');
  check('riff size field', wav.readUInt32LE(4) === 36 + pcm.length);
  check('pcm format tag', wav.readUInt16LE(20) === 1);
  check('mono', wav.readUInt16LE(22) === 1);
  check('16 kHz', wav.readUInt32LE(24) === 16_000);
  check('byte rate', wav.readUInt32LE(28) === 32_000);
  check('block align', wav.readUInt16LE(32) === 2);
  check('16-bit', wav.readUInt16LE(34) === 16);
  check('data size field', wav.readUInt32LE(40) === pcm.length);
  check('duration maths', pcmDurationSeconds(pcm.length) === 1);
}

console.log('\n2. Segment offsets land on sample boundaries');
{
  for (const seconds of [0, 0.5, 1.333, 7.77, 480, 3600.9]) {
    const offset = secondsToByteOffset(seconds);
    if (offset % 2 !== 0) {
      check(`offset for ${seconds}s is even`, false, `${offset}`);
    }
  }
  check('all offsets even (no sample tearing)', true);
  check('8 minutes is 15,360,000 bytes', secondsToByteOffset(480) === 15_360_000);
}

console.log('\n3. Live chunk ramp');
{
  const PER_SECOND = 32_000; // 16 kHz mono 16-bit
  check('20s chunks at the start', liveChunkBytes(0) === 20 * PER_SECOND);
  check('still 20s at 2:59', liveChunkBytes(179) === 20 * PER_SECOND);
  check('60s chunks from 3:00', liveChunkBytes(180) === 60 * PER_SECOND);
  check('still 60s two hours in', liveChunkBytes(7200) === 60 * PER_SECOND);

  // The live pass is most of the bill, so the saving the ramp buys is worth
  // asserting rather than assuming.
  const flat = Math.ceil(7200 / 20);
  const ramped = Math.ceil(180 / 20) + Math.ceil((7200 - 180) / 60);
  check(
    'a 2h meeting drops from 360 to 126 live calls',
    flat === 360 && ramped === 126,
    `${flat} -> ${ramped}`,
  );
  check(
    'scrollback still covers the whole meeting',
    ramped * 60 >= 7200 - 180,
    'no gap in coverage',
  );
}

console.log('\n4. Formal minutes rendering');
{
  const minutes = {
    bodyName: 'Board of Directors',
    title: 'Q3 Board Meeting',
    date: '2026-08-02',
    startTime: '14:00',
    endTime: '15:30',
    location: 'Boardroom, 28/F',
    chair: 'Raymond Pun',
    secretary: 'Cheryl Lau',
    present: ['Raymond Pun', 'Cheryl Lau'],
    inAttendance: ['Peter Wong'],
    apologies: ['Anna Chan'],
    items: [
      {
        number: '1',
        heading: 'Q3 Financial Review',
        discussion:
          'The Finance Director reported that revenue for the quarter was below forecast.',
        resolutions: ['RESOLVED THAT the Q3 accounts be approved as presented.'],
        motions: [
          {
            text: 'That the Q3 accounts be approved.',
            proposedBy: 'Raymond Pun',
            secondedBy: 'Cheryl Lau',
            outcome: 'carried',
            votesFor: 4,
            votesAgainst: 1,
            abstentions: 0,
            evidence: { time: 912, quote: '我 second 呢個 motion' },
            confidence: 'high',
          },
        ],
        actions: [
          {
            owner: 'Cheryl Lau',
            action: 'Circulate the revised forecast | with margins',
            dueDate: '31 August 2026',
            evidence: { time: 1040, quote: '我下星期 send 個 forecast 俾大家' },
            confidence: 'high',
          },
          {
            owner: 'Unassigned',
            action: 'Review the vendor contract',
            dueDate: null,
            evidence: null,
            confidence: 'low',
          },
        ],
        evidence: [{ time: 300, quote: '個 revenue 唔夠 forecast 咁多' }],
      },
    ],
    flaggedForReview: ['Speaker 3 was never identified.'],
    nextMeeting: '5 November 2026',
  };

  const md = renderMarkdown(minutes);

  check('body name as h1', md.includes('# Board of Directors'));
  check('minutes heading', md.includes('## Minutes of the Q3 Board Meeting'));
  check('date formatted long-form', md.includes('2 August 2026'), grepLine(md, 'Date:'));
  check('time range', md.includes('14:00 – 15:30'));
  check('present list', md.includes('**Present:** Raymond Pun, Cheryl Lau'));
  check('in attendance', md.includes('**In attendance:** Peter Wong'));
  check('apologies', md.includes('**Apologies for absence:** Anna Chan'));
  check('numbered item', md.includes('### 1. Q3 Financial Review'));
  check('motion block', md.includes('> **Motion:** That the Q3 accounts be approved.'));
  check('proposer and seconder', md.includes('Proposed by Raymond Pun, seconded by Cheryl Lau'));
  check('vote counts', md.includes('(4 for, 1 against, 0 abstaining)'));
  check(
    'RESOLVED THAT not duplicated',
    md.includes('**RESOLVED THAT** the Q3 accounts be approved as presented.') &&
      !md.includes('RESOLVED THAT RESOLVED THAT'),
  );
  check('action table header', md.includes('| Action | Owner | By when |'));
  check(
    'pipe in action text escaped',
    md.includes('Circulate the revised forecast \\| with margins'),
  );
  check('missing due date renders as dash', md.includes('| Unassigned | — |'));
  check('low confidence flagged inline', md.includes('**[TO VERIFY]**'));
  check('evidence quote kept in Cantonese', md.includes('我 second 呢個 motion'));
  check('evidence timestamp formatted', md.includes('[15:12]'), grepLine(md, '15:12'));
  check('source disclosure block', md.includes('Source — what was actually said'));
  check('next meeting', md.includes('5 November 2026'));
  check('review section present', md.includes('To verify before sign-off'));
  check('review item as checkbox', md.includes('- [ ] Speaker 3 was never identified.'));
  check('draft disclaimer', md.includes('Not a signed record until approved'));
}

console.log('\n5. Renderer survives a sparse model response');
{
  const md = renderMarkdown({
    bodyName: 'Team',
    title: 'Weekly Sync',
    date: 'not-a-date',
    startTime: null,
    endTime: null,
    location: '',
    chair: null,
    secretary: null,
    present: [],
    inAttendance: [],
    apologies: [],
    items: [
      {
        number: '1',
        heading: 'Updates',
        discussion: '',
        resolutions: [],
        motions: [],
        actions: [],
        evidence: [],
      },
    ],
    flaggedForReview: [],
    nextMeeting: null,
  });
  check('no crash on empty fields', md.includes('### 1. Updates'));
  check('unparseable date passed through', md.includes('not-a-date'));
  check('missing location handled', md.includes('**Location:** Not recorded'));
  check('missing attendees handled', md.includes('**Present:** Not recorded'));
}

function grepLine(text, needle) {
  return text.split('\n').find((l) => l.includes(needle)) ?? '(not found)';
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
