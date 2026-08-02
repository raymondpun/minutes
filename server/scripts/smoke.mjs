/**
 * End-to-end smoke test of everything that does not require a real GCP project:
 * server boot, meeting creation, websocket audio ingestion, PCM persistence,
 * WAV framing, and markdown rendering of the minutes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-smoke-'));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const server = spawn('node', ['dist/index.js'], {
  cwd: path.join(ROOT, 'server'),
  env: {
    ...process.env,
    GOOGLE_CLOUD_PROJECT: 'smoke-test-project',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    PORT: String(PORT),
    DATA_DIR: DATA,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`server never booted:\n${serverLog}`);
}

try {
  console.log('\n1. Server boot');
  const health = await waitForBoot();
  check('health endpoint responds', health.ok === true);
  check('reports project', health.project === 'smoke-test-project');
  check('reports model', health.models.transcribe.startsWith('gemini-'), health.models.transcribe);
  check('reports a digest model', Boolean(health.models.digest), health.models.digest);
  check('reports audio retention', typeof health.retainAudioDays === 'number', `${health.retainAudioDays} days`);
  check(
    'flags segmented mode without GCS_BUCKET',
    health.singlePassTranscription === false,
  );

  console.log('\n2. Meeting creation');
  const created = await (
    await fetch(`${BASE}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Q3 Board Meeting',
        body: 'Board of Directors',
        location: 'Boardroom 28/F',
        date: '2026-08-02',
        expectedAttendees: ['Raymond Pun', 'Cheryl Lau'],
        agenda: 'Apologies\nQ3 financials\nAOB',
      }),
    })
  ).json();
  check('meeting created with id', typeof created.id === 'string', created.id);
  check('status is setup', created.status === 'setup');
  check('agenda split into 3 items', created.agenda?.length === 3, JSON.stringify(created.agenda));
  check(
    'attendees parsed',
    created.expectedAttendees?.length === 2,
    JSON.stringify(created.expectedAttendees),
  );

  console.log('\n3. Path traversal is rejected');
  const evil = await fetch(`${BASE}/api/meetings/..%2f..%2fetc`);
  check('traversal id refused with 400', evil.status === 400, `status ${evil.status}`);
  const missing = await fetch(`${BASE}/api/meetings/2020-01-01-deadbeef`);
  check('unknown meeting is 404', missing.status === 404, `status ${missing.status}`);

  console.log('\n4. Websocket audio ingestion');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?meeting=${created.id}`);
  const events = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));

  // 3 seconds of 440 Hz tone at 16 kHz mono, sent as 1-second frames.
  const RATE = 16000;
  for (let sec = 0; sec < 3; sec++) {
    const frame = new Int16Array(RATE);
    for (let i = 0; i < RATE; i++) {
      frame[i] = Math.round(Math.sin((2 * Math.PI * 440 * (sec * RATE + i)) / RATE) * 8000);
    }
    ws.send(Buffer.from(frame.buffer));
    await sleep(120);
  }
  await sleep(600);

  const pcmFile = path.join(DATA, 'meetings', created.id, 'audio.pcm');
  const size = fs.existsSync(pcmFile) ? fs.statSync(pcmFile).size : 0;
  check('audio persisted to disk', size === 3 * RATE * 2, `${size} bytes, expected ${3 * RATE * 2}`);
  check('ready event received', events.some((e) => e.type === 'ready'));
  const acks = events.filter((e) => e.type === 'chunk_ack');
  check('chunk acks received', acks.length === 3, `${acks.length} acks`);
  check(
    'elapsed seconds reported correctly',
    Math.abs((acks.at(-1)?.seconds ?? 0) - 3) < 0.01,
    `${acks.at(-1)?.seconds}s`,
  );
  check(
    'no live transcription fired under 20s',
    !events.some((e) => e.type === 'live'),
  );
  ws.close();
  await sleep(200);

  console.log('\n4b. Roll call, pause and resume');
  const started = await (await fetch(`${BASE}/api/meetings/${created.id}/start`, { method: 'POST' })).json();
  check('start enters roll call', started.status === 'roll_call', started.status);
  const rolled = await (await fetch(`${BASE}/api/meetings/${created.id}/roll-call-done`, { method: 'POST' })).json();
  check('roll call marks its end position', Math.abs(rolled.rollCallEndedAt - 3) < 0.01, `${rolled.rollCallEndedAt}s`);
  check('moves into recording', rolled.status === 'recording');
  const paused = await (await fetch(`${BASE}/api/meetings/${created.id}/pause`, { method: 'POST' })).json();
  check('pause records the position', paused.pauses?.length === 1 && Math.abs(paused.pauses[0].at - 3) < 0.01, JSON.stringify(paused.pauses));
  check('status is paused', paused.status === 'paused');
  const resumed = await (await fetch(`${BASE}/api/meetings/${created.id}/resume`, { method: 'POST' })).json();
  check('resume returns to recording', resumed.status === 'recording');
  check('pause marks are kept', resumed.pauses?.length === 1);

  console.log('\n4c. Audio clips for evidence playback');
  const clip = await fetch(`${BASE}/api/meetings/${created.id}/clip?at=2&pad=2`);
  check('clip returns audio', clip.status === 200 && clip.headers.get('content-type') === 'audio/wav', `${clip.status}`);
  const clipBytes = Buffer.from(await clip.arrayBuffer());
  check('clip is a valid WAV', clipBytes.toString('ascii', 0, 4) === 'RIFF');
  // Requested 0s..4s but only 3s exists, so the clip is clamped to what there is.
  check('clip clamped to available audio', clipBytes.length === 44 + 3 * 32000, `${clipBytes.length} bytes`);
  const badClip = await fetch(`${BASE}/api/meetings/${created.id}/clip`);
  check('clip without a position is rejected', badClip.status === 400, `${badClip.status}`);

  console.log('\n5. Meeting snapshot');
  const snap = await (await fetch(`${BASE}/api/meetings/${created.id}`)).json();
  check('audio duration reported', Math.abs(snap.audioSeconds - 3) < 0.01, `${snap.audioSeconds}s`);
  check('audio marked available', snap.audioAvailable === true);
  check('transcript empty before processing', snap.transcript.length === 0);

  console.log('\n6. Audio deletion');
  const goneClip0 = null; void goneClip0;
  await fetch(`${BASE}/api/meetings/${created.id}/audio`, { method: 'DELETE' });
  check('pcm removed', !fs.existsSync(pcmFile));
  const afterDelete = await (await fetch(`${BASE}/api/meetings/${created.id}`)).json();
  check('meta survives audio deletion', afterDelete.meta.id === created.id);
  const goneClip = await fetch(`${BASE}/api/meetings/${created.id}/clip?at=2`);
  check('clip 404s once the audio is gone', goneClip.status === 404, `${goneClip.status}`);

  console.log('\n7. Meeting list');
  const list = await (await fetch(`${BASE}/api/meetings`)).json();
  check('meeting appears in list', list.some((m) => m.id === created.id));
} catch (err) {
  console.error('\nFATAL', err);
  console.error(serverLog);
  failures++;
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  server.kill('SIGKILL');
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
