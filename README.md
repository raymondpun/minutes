# Minutes

Put a phone on the table, press start, chair your meeting. When you press stop
you get formal minutes in English — resolutions, motions, votes, action items —
drafted from the recording, with the original Cantonese quoted underneath every
claim so you can check the translation was fair.

Built for **in-person** meetings conducted in **Cantonese mixed with English**.
Runs entirely in your own Google Cloud project.

---

## How it works

```
phone mic
   │  16 kHz mono PCM, streamed over a websocket
   ▼
server ──► every 20s ──► Gemini ──► rough live transcript (on screen, disposable)
   │
   │  full recording on disk
   ▼
on Stop ──► Gemini ──► verbatim diarized transcript, Cantonese in 口語
              │
              ├──► speaker names, from the roll-call at the start
              │      └──► YOU CONFIRM THEM  ◄── the one human checkpoint
              │
              └──► Gemini ──► formal English minutes, every claim timestamped
                                └──► audio deleted
```

Two passes, and the reason is a hard constraint rather than a design
preference. Chirp 3 on Vertex supports streaming, and supports speaker
diarization, but [not at the same time](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
— diarization is `BatchRecognize`/`Recognize` only. Since knowing who said what
is the whole point of minutes, the authoritative transcript has to come from the
complete recording at the end. The live pass exists only so you can see the mic
is working while there is still time to move it.

Gemini rather than a dedicated speech engine, because dedicated engines are
trained one language at a time and mangle code-switching. `我哋個 budget 已經
approve 咗` is one sentence to a multimodal model and two broken ones to an ASR
pipeline.

## What it will and will not do

**Will**

- Record a long in-person meeting from a phone on the table
- Transcribe Cantonese/English code-switching, keeping Cantonese in 口語
  (`係 唔係 嘅 咗`) and English in Latin script
- Separate speakers and name them from the introductions at the start
- Draft formal minutes: `RESOLVED THAT…`, motions with proposer/seconder/votes,
  actions with owner and due date
- Anchor every resolution and action to a timestamp and a verbatim quote
- Flag what it could not establish, instead of smoothing it into confident prose
- Delete the audio once the minutes are drafted

**Will not**

- Recognise a voice from a previous meeting. That needs stored voiceprints,
  which is biometric data with its own legal weight class. Deliberately absent.
- Name someone who never introduced themselves and is never addressed by name.
  They appear as "an unidentified attendee" and get flagged.
- Produce a signed record. It produces a draft that a human approves.

## Setup

You need a GCP project with billing, and `gcloud`.

```bash
git clone <this repo> && cd minutes
npm install
cp .env.example .env      # set GOOGLE_CLOUD_PROJECT
gcloud auth application-default login
gcloud services enable aiplatform.googleapis.com
npm run dev               # server :8080, web :5173
```

`http://localhost:5173` works on your laptop for testing.

### Getting it onto a phone

Browsers refuse microphone access outside a secure context, so a phone
**cannot** use `http://192.168.x.x:5173`. Two options:

```bash
./deploy.sh YOUR_PROJECT_ID asia-east2     # Cloud Run, real HTTPS, ~5 min
```

or, for a quick test against your laptop:

```bash
cloudflared tunnel --url http://localhost:8080
```

Then open the HTTPS URL on the phone and add it to the home screen — iOS
`Share → Add to Home Screen`, Android `menu → Install app`. Running from the
home screen keeps Safari's chrome from stealing taps mid-meeting.

### Long meetings

Optional, and worth it above about 40 minutes:

```bash
gcloud storage buckets create gs://your-minutes-audio --location=asia-east2
echo "GCS_BUCKET=your-minutes-audio" >> .env
```

Without a bucket, recordings over ~8 minutes are transcribed in overlapping
segments and stitched. That works, but speaker labels drift a little across
seams. With a bucket the whole meeting goes to Gemini in one request and the
labels stay stable start to finish.

## Getting good results

The model is not the bottleneck. In order of impact:

1. **Microphone placement.** Phone flat in the middle of the table, screen up,
   away from laptop fans and aircon vents. Beyond about two metres, speech
   becomes mush and nothing downstream recovers it. For 8+ people, a ~HK$900 USB
   conference puck will do more for your minutes than any prompt engineering.
2. **Fill in the attendee list** before you start. It turns name identification
   from a guessing problem into a matching problem, and fixes spelling.
3. **Do the roll-call.** Everyone says their own name at the start. Anyone who
   skips it, or arrives late, will not be named.
4. **Watch the live transcript for the first minute.** If the person at the far
   end never appears, move the phone. This is the entire reason the live pass
   exists.
5. **Give it the agenda.** Minutes get structured around it.

### iPhone

If the screen locks, iOS suspends the audio context and recording stops. The app
takes a wake lock where Safari supports it (16.4+) and warns you loudly where it
does not — but before a long meeting, set **Settings → Display & Brightness →
Auto-Lock → Never**, and do not switch apps.

## Privacy

- Audio goes to Vertex AI in **your** project. Not to a third-party SaaS.
- The recording is deleted as soon as the minutes are drafted — locally and from
  GCS. Transcript and minutes are kept.
- The app makes you confirm you have told the room before it will start. You are
  recording colleagues; under the PDPO they are entitled to know what is being
  collected and why.
- No voiceprints are computed or stored, so nobody is identifiable across
  meetings.

`./deploy.sh` deploys with `--allow-unauthenticated`. The URL is unguessable but
public — put IAP in front of it before it holds anything sensitive.

## Cost

Roughly, for a 60-minute meeting on `gemini-3.6-flash`
([$1.50 / $7.50 per 1M tokens](https://evolink.ai/blog/gemini-3-6-flash-release-date)),
audio being ~32 tokens/second:

| Stage | Notes | Approx |
| --- | --- | --- |
| Live pass | 180 × 20s chunks | $0.20 |
| Full transcript | 115k audio tokens in, long transcript out | $0.35 |
| Speaker ID | text only | $0.02 |
| Minutes | transcript in, document out | $0.10 |
| | | **~$0.70** |

Plus Cloud Run at `--min-instances 1`, around $10–15/month. Drop it to 0 if you
can tolerate a cold start before a meeting.

## Models

Checked August 2026: **Gemini 3.5 Pro is not released** — still delayed. 3.1 Pro
is preview only. `gemini-3.6-flash` is GA on Vertex, natively multimodal, does
transcription with diarization, and is what this uses.

Model IDs are in `.env` and referenced from one config object. Swap them the day
something better ships:

```bash
MODEL_LIVE=gemini-3.6-flash
MODEL_TRANSCRIBE=gemini-3.6-flash
MODEL_MINUTES=gemini-3.6-flash
```

## Layout

```
server/src/
  index.ts            HTTP + websocket, job orchestration
  config.ts           all env and audio constants
  store.ts            one directory per meeting, no database
  wav.ts              PCM framing
  gemini.ts           Vertex client, retries, JSON coercion
  prompts.ts          ← the actual product. Language rules, grounding rules,
                        formal-minutes house style.
  pipeline/
    live.ts           20s chunk → rough text
    transcribe.ts     full recording → diarized transcript
    identify.ts       roll-call → real names
    minutes.ts        transcript → formal minutes + markdown
web/src/
  lib/recorder.ts     AudioWorklet → 16 kHz PCM (see the comment on why not
                      MediaRecorder)
  lib/uplink.ts       websocket with reconnect and a bounded backlog
  lib/wakeLock.ts     keeping the phone awake
  screens/            setup → preflight → recording → speakers → minutes
```

```bash
npm test        # WAV framing, minutes rendering, server + websocket smoke test
npm run typecheck
```

Neither suite touches Vertex, so both run without credentials.

## Known limits

- **One meeting at a time per instance.** Audio streams to instance-local disk,
  so `deploy.sh` pins `--max-instances 1` with session affinity. Fine for one
  person; needs GCS-backed streaming for a team.
- **Cloud Run's disk is ephemeral.** Past meetings vanish when the instance
  recycles. Set `GCS_BUCKET`, mount a volume, or run it locally if you need an
  archive.
- **The queue is capped at ~5 minutes** of buffered audio when the connection
  drops. Longer than that and the oldest audio is discarded rather than killing
  the tab.
- **No auth.** See the privacy note above.
