/**
 * Preflight check. Run this before you are in a room with people.
 *
 *   npm run check                      -- ~4 tiny calls, a fraction of a cent
 *   npm run check -- recording.m4a     -- also run a real recording all the way
 *                                         through to drafted minutes
 *
 * No API keys anywhere. Vertex uses Application Default Credentials: locally
 * that is `gcloud auth application-default login`, and on Cloud Run it is the
 * attached service account. The only thing in your config is the project id.
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.GOOGLE_CLOUD_PROJECT ??= '';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

let failed = false;

function pass(name, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(name, why, fix) {
  failed = true;
  console.log(`  ${RED}✗${RESET} ${name}`);
  console.log(`    ${RED}${why}${RESET}`);
  if (fix) console.log(`    ${BOLD}Fix:${RESET} ${fix}`);
}

function heading(text) {
  console.log(`\n${BOLD}${text}${RESET}`);
}

/* ------------------------------------------------------------- 1. config -- */

heading('1. Configuration');

if (!process.env.GOOGLE_CLOUD_PROJECT) {
  fail(
    'GOOGLE_CLOUD_PROJECT is set',
    'Not set, so there is no project to call.',
    'cp .env.example .env, then set GOOGLE_CLOUD_PROJECT=your-project-id',
  );
  console.log(`\n${RED}Cannot continue without a project.${RESET}\n`);
  process.exit(1);
}

const { config } = await import('../dist/config.js');
pass('project', config.projectId);
pass('region', config.location);
// Usually all four are the same model, so collapse them rather than printing
// the same id four times.
const modelSet = [...new Set(Object.values(config.models))];
pass(
  modelSet.length === 1 ? 'model' : 'models',
  modelSet.length === 1
    ? modelSet[0]
    : Object.entries(config.models)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
);
pass(
  'audio retention',
  config.retainAudioDays === Number.POSITIVE_INFINITY
    ? 'kept indefinitely'
    : config.retainAudioDays === 0
      ? 'deleted once minutes are drafted'
      : `${config.retainAudioDays} days`,
);
pass(
  'transcription mode',
  config.gcsBucket ? `single pass via gs://${config.gcsBucket}` : 'segmented (no GCS_BUCKET)',
);

/* -------------------------------------------------------- 2. credentials -- */

heading('2. Credentials');

try {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw new Error('no access token returned');

  let who = 'application default credentials';
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    who = `key file ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`;
  } else if (process.env.K_SERVICE) {
    who = 'Cloud Run service account';
  }
  pass('access token obtained', who);

  const adcProject = await auth.getProjectId().catch(() => null);
  if (adcProject && adcProject !== config.projectId) {
    console.log(
      `    ${DIM}note: credentials default to "${adcProject}" but GOOGLE_CLOUD_PROJECT is "${config.projectId}". The env var wins.${RESET}`,
    );
  }
} catch (err) {
  fail(
    'access token obtained',
    err instanceof Error ? err.message : String(err),
    'gcloud auth application-default login',
  );
  console.log(`\n${RED}Cannot reach Vertex without credentials.${RESET}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------- 3. vertex -- */

heading('3. Vertex AI');

const { generate, generateJson, audioPart } = await import('../dist/gemini.js');

// Structured output first: it exercises auth, region, model availability and
// responseSchema in one call, and every stage of the pipeline depends on it.
try {
  const result = await generateJson({
    model: config.models.minutes,
    label: 'check-schema',
    parts: [
      {
        text: 'Reply with ok set to true and note set to the single word "ready".',
      },
    ],
    responseSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
      required: ['ok', 'note'],
    },
    maxOutputTokens: 256,
  });
  if (typeof result?.ok !== 'boolean') throw new Error('schema not honoured');
  pass(`${config.models.minutes} reachable, structured output works`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  let fix = 'Check the model id and region in .env.';
  if (/permission|denied|forbidden|403/i.test(message)) {
    fix = 'gcloud services enable aiplatform.googleapis.com --project ' + config.projectId +
      '\n         and grant roles/aiplatform.user to whoever you authenticated as.';
  } else if (/not found|404|does not exist|unsupported/i.test(message)) {
    fix =
      `"${config.models.minutes}" is not served in ${config.location}.\n` +
      `         Either point the models at one that is, e.g.\n` +
      `           MODEL_TRANSCRIBE=gemini-3.5-flash MODEL_MINUTES=gemini-3.5-flash\n` +
      `         or use the global endpoint, which routes to wherever the model lives\n` +
      `         but gives up regional data residency:\n` +
      `           GOOGLE_CLOUD_LOCATION=global`;
  } else if (/billing/i.test(message)) {
    fix = 'Enable billing on the project.';
  }
  fail(`${config.models.minutes} reachable`, message, fix);
}

// Audio input is a separate capability from text, and the whole app rests on
// it, so prove the model accepts an inline audio part rather than assuming.
if (!failed) {
  try {
    const { pcmToWav } = await import('../dist/wav.js');
    // Two seconds of a quiet tone. It contains no speech, so an empty
    // transcription is the correct answer -- what is being tested is that the
    // request shape is accepted at all.
    const samples = new Int16Array(16_000 * 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 1200);
    }
    const wav = pcmToWav(Buffer.from(samples.buffer));

    await generate({
      model: config.models.transcribe,
      label: 'check-audio',
      parts: [
        audioPart({ bytes: wav, mimeType: 'audio/wav' }),
        { text: 'Transcribe any speech in this clip. If there is none, reply with the single word NONE.' },
      ],
      maxOutputTokens: 128,
    });
    pass(`${config.models.transcribe} accepts inline audio`);
  } catch (err) {
    fail(
      `${config.models.transcribe} accepts inline audio`,
      err instanceof Error ? err.message : String(err),
      'The model may not support audio input in this region.',
    );
  }
}

/* -------------------------------------------------------------- 4. bucket -- */

if (config.gcsBucket) {
  heading('4. Cloud Storage');
  try {
    const { Storage } = await import('@google-cloud/storage');
    const bucket = new Storage({ projectId: config.projectId }).bucket(config.gcsBucket);
    const probe = bucket.file(`meetings/_preflight/probe.txt`);
    await probe.save('preflight', { resumable: false });
    const [contents] = await probe.download();
    if (contents.toString() !== 'preflight') throw new Error('read back the wrong bytes');
    await probe.delete({ ignoreNotFound: true });
    pass(`gs://${config.gcsBucket} readable and writable`);
  } catch (err) {
    fail(
      `gs://${config.gcsBucket} readable and writable`,
      err instanceof Error ? err.message : String(err),
      `gcloud storage buckets add-iam-policy-binding gs://${config.gcsBucket} --member=user:YOU@example.com --role=roles/storage.objectAdmin`,
    );
  }
} else {
  heading('4. Cloud Storage');
  console.log(
    `  ${DIM}- no GCS_BUCKET set. Meetings over ~8 minutes will be transcribed in`,
  );
  console.log(`    segments, and nothing survives a Cloud Run restart.${RESET}`);
}

/* --------------------------------------------------- 5. real recording ---- */

const audioArg = process.argv[2];

if (audioArg) {
  heading('5. Full pipeline on a real recording');

  if (!fs.existsSync(audioArg)) {
    fail('file exists', `${audioArg} not found`);
  } else if (failed) {
    console.log(`  ${DIM}skipped -- fix the failures above first${RESET}`);
  } else {
    const bytes = fs.readFileSync(audioArg);
    const ext = path.extname(audioArg).toLowerCase();
    const mime =
      { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[ext] ??
      'audio/wav';
    console.log(`  ${DIM}${(bytes.length / 1e6).toFixed(1)} MB, sending as ${mime}${RESET}`);

    const { TRANSCRIPT_SCHEMA, diarizedTranscriptPrompt } = await import(
      '../dist/prompts.js'
    );

    try {
      const t0 = Date.now();
      const { segments } = await generateJson({
        model: config.models.transcribe,
        label: 'check-transcribe',
        parts: [
          audioPart({ bytes, mimeType: mime }),
          {
            text: diarizedTranscriptPrompt({
              offsetSeconds: 0,
              knownSpeakers: [],
              expectedAttendees: [],
              isFirstSegment: true,
            }),
          },
        ],
        responseSchema: TRANSCRIPT_SCHEMA,
        maxOutputTokens: 65_536,
      });
      pass(
        'transcribed with speaker separation',
        `${segments.length} segments in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      const speakers = [...new Set(segments.map((s) => s.speaker))];
      pass('distinct speakers found', speakers.join(', '));

      // The failure that matters most and shows up least: the model quietly
      // rewriting spoken Cantonese into formal written Chinese, which destroys
      // the transcript as evidence of what anyone actually said.
      const all = segments.map((s) => s.text).join('');
      const spoken = (all.match(/[係唔嘅咗喺冇嗰啲哋嘢乜]/g) ?? []).length;
      const written = (all.match(/[是的了在沒那們什麼]/g) ?? []).length;
      if (spoken + written === 0) {
        console.log(`    ${DIM}no Chinese in this clip, so 口語 could not be checked${RESET}`);
      } else if (spoken >= written) {
        pass('Cantonese written as spoken (口語)', `${spoken} colloquial vs ${written} formal`);
      } else {
        fail(
          'Cantonese written as spoken (口語)',
          `${written} formal forms vs ${spoken} colloquial -- the model is converting to 書面語`,
          'Strengthen rule 1 in LANGUAGE_RULES in server/src/prompts.ts, or lower the temperature.',
        );
      }

      console.log(`\n${BOLD}  Transcript${RESET}`);
      for (const s of segments.slice(0, 12)) {
        console.log(
          `  ${DIM}[${s.start.toFixed(0).padStart(4)}s]${RESET} ${BOLD}${s.speaker}${RESET}  ${s.text}`,
        );
      }
      if (segments.length > 12) console.log(`  ${DIM}… ${segments.length - 12} more${RESET}`);

      const { identifySpeakers } = await import('../dist/pipeline/identify.js');
      const identified = await identifySpeakers(segments, []);
      console.log(`\n${BOLD}  Speakers${RESET}`);
      for (const s of identified) {
        console.log(
          `  ${s.name ? `${GREEN}${s.name}${RESET}` : `${RED}unidentified${RESET}`}` +
            ` ${DIM}(${s.speakerId}, ${s.confidence}, ${s.segmentCount} turns)${RESET}` +
            (s.evidence ? `\n    ${DIM}from: “${s.evidence}”${RESET}` : ''),
        );
      }

      const { draftMinutes, renderMarkdown } = await import('../dist/pipeline/minutes.js');
      const { applySpeakerNames } = await import('../dist/pipeline/identify.js');
      const minutes = await draftMinutes(
        {
          id: 'preflight',
          title: 'Preflight Check',
          body: '',
          location: '',
          date: new Date().toISOString().slice(0, 10),
          expectedAttendees: [],
          apologies: [],
          agenda: [],
          pauses: [],
          status: 'drafting',
          createdAt: new Date().toISOString(),
        },
        applySpeakerNames(segments, identified),
        identified,
      );
      pass('minutes drafted', `${minutes.items.length} items, ${minutes.flaggedForReview.length} flagged`);

      const out = path.resolve('preflight-minutes.md');
      fs.writeFileSync(out, renderMarkdown(minutes));
      console.log(`\n  ${BOLD}Written to ${out}${RESET}`);
      console.log(`  ${DIM}Read it. This is what a real meeting will produce.${RESET}`);
    } catch (err) {
      fail('full pipeline', err instanceof Error ? err.message : String(err));
    }
  }
} else {
  heading('5. Full pipeline on a real recording');
  console.log(`  ${DIM}skipped. To test for real:${RESET}`);
  console.log(`    ${DIM}record two minutes on your phone with a colleague, both`);
  console.log(`     saying your names, then:${RESET}`);
  console.log(`    npm run check -- ~/Downloads/test.m4a`);
}

console.log(
  failed
    ? `\n${RED}${BOLD}Not ready.${RESET} Fix the above before relying on this in a meeting.\n`
    : `\n${GREEN}${BOLD}Ready.${RESET}\n`,
);
process.exit(failed ? 1 : 0);
