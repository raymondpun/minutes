# Minutes

Put a phone on the table, press start, chair your meeting. When you press stop
you get formal minutes in English — resolutions, motions, votes, action items —
drafted from the recording, with the original Cantonese quoted underneath every
claim so you can check the translation was fair.

Built for **in-person** meetings conducted in **Cantonese mixed with English**.
Runs entirely in your own Google Cloud project.

---

## What you actually do

**Press start. Press stop.** Everything between is automatic.

```
  you                        the app
  ───                        ───────
  press Start        ──►     records; prompts the room to introduce themselves
                             detects when the introductions finish, moves on
                             transcribes in the background
                             posts a summary block every ~5 min
  (glance at the                 you can scroll back through it any time
   summary if you                 or search the raw transcript
   want to)                   you can Pause and Resume for a break

  press Stop         ──►     transcribes the whole recording with speakers
                             maps the voices to the names from the roll call
                             drafts the formal minutes
                             ── only stops to ask if a voice went unidentified

  read the minutes
```

The only interruption that survives is the one that earns its place: if a voice
was never named, or a name was inferred rather than heard, it stops and asks.
When everyone introduced themselves properly it goes straight through.

## How it works

```
phone mic
   │  16 kHz mono PCM, streamed over a websocket
   ▼
server ──► 20s chunks (60s after the mic check) ──► Gemini ──► live transcript
   │                                                              │
   │                                                              ▼
   │                                        every ~5 min ──► summary block
   │  full recording accumulating on disk
   ▼
on Stop ──► Gemini ──► verbatim diarized transcript, Cantonese in 口語
              │
              ├──► voices matched to names using the roll call
              │      └──► asks you only if something is uncertain
              │
              └──► Gemini ──► formal English minutes, every claim timestamped
                                └──► audio retained 30 days for playback
```

## How the app knows who is speaking

This is the part that surprises people, so it is worth being precise.

**It does not happen live.** The 20s and 60s chunks are transcribed
independently and carry no speaker identity — a chunk at 01:00:00 has no idea
what a chunk at 00:00:30 heard. Chunked audio fundamentally cannot do this.

**It happens once, at the end, over the whole recording in a single request.**
That is the entire reason the authoritative transcript is built from the
complete file rather than assembled from the live fragments. In that one
request the model hears the roll call at 00:00:30 *and* the voice at 01:00:00,
and can tell they are the same person. Two steps:

1. **Diarization — acoustic.** The model separates the voices and labels them
   `Speaker 1`, `Speaker 2`, `Speaker 3`, consistently from the first minute to
   the last. This is voice similarity. It knows nothing about names.
2. **Name mapping — textual.** A second, text-only pass reads that transcript,
   finds `Speaker 2: 我係 Cheryl，負責 finance` at 00:00:30, and maps Speaker 2
   to Cheryl everywhere — including at 01:00:00. It also picks up names from how
   people address each other (`Raymond 你點睇?` followed by an answer).

**There is no magic phrase.** Anything that reads as a self-introduction works:
`我係 Raymond` · `Hi, I'm Cheryl` · `Peter here, operations` · `我叫陳大文`.
Marking where the roll call ended just tells step 2 where to look hardest.

**The one thing that weakens it:** without a `GCS_BUCKET`, long recordings are
transcribed in 8-minute segments, and speaker labels drift across the seams.
Known labels are carried forward to limit it, but single-pass is materially
better. For meetings over about 40 minutes, configure the bucket.

Worth noting that a dedicated speech engine cannot rescue this either. Chirp 3
on Vertex supports streaming, and supports diarization, but
[not at the same time](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
— diarization is `BatchRecognize`/`Recognize` only. There is no configuration of
any of this that gives you live speaker labels.

## Why Gemini rather than a speech engine

Dedicated engines are trained one language at a time and mangle code-switching. `我哋個 budget 已經
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
- Let you play back the audio behind any quote or transcript line
- Export to Word (.docx), Markdown, JSON or plain text
- Pause and resume, releasing the mic so the room can see it has stopped

**Will not**

- Recognise a voice from a previous meeting. That needs stored voiceprints,
  which is biometric data with its own legal weight class. Deliberately absent.
- Name someone who never introduced themselves and is never addressed by name.
  They appear as "an unidentified attendee" and get flagged.
- Attribute speakers in the live transcript. That only becomes possible once the
  whole recording can be heard at once — see above.
- Produce a signed record. It produces a draft that a human approves.

## Setup

You need a GCP project with billing, and `gcloud`. **There are no API keys.**
Vertex authenticates with Application Default Credentials — one `gcloud`
command locally, and the attached service account on Cloud Run. Nothing to
create, paste, rotate or leak; the only thing in `.env` is the project id.

```bash
git clone <this repo> && cd minutes
npm install
cp .env.example .env      # set GOOGLE_CLOUD_PROJECT
gcloud auth application-default login
gcloud services enable aiplatform.googleapis.com

npm run check             # confirm it can actually reach Vertex
npm run dev               # server :8080, web :5173
```

`http://localhost:5173` works on your laptop for testing.

### Check it works before you need it

```bash
npm run check
```

Four tiny calls — a fraction of a cent — verifying credentials, that the model
is served in your region, that structured output is honoured, that inline audio
is accepted, and that the bucket is readable and writable. Every failure prints
the exact command that fixes it.

The more valuable mode takes a real recording:

```bash
npm run check -- ~/Downloads/test.m4a
```

Record two minutes on your phone with a colleague, both saying your names, and
run it through. It prints the transcript with speakers, the name mapping and
the evidence behind it, drafts the minutes to `preflight-minutes.md`, and
checks the one failure that hides best: whether the model is quietly rewriting
spoken Cantonese (係 唔係 嘅 咗) into formal 書面語 (是 不是 的 了), which would
destroy the transcript's value as evidence.

Do this before a meeting that matters.

### Getting it onto a phone

Browsers refuse microphone access outside a secure context, so a phone
**cannot** use `http://192.168.x.x:5173`. Two options:

```bash
./deploy.sh YOUR_PROJECT_ID asia-east2     # Cloud Run, real HTTPS, ~5 min
```

**→ [DEPLOY.md](DEPLOY.md) is the full step-by-step, and it needs nothing
installed locally** — the whole deployment runs in Cloud Shell, a terminal in
your browser that already has gcloud, Node and git. Covers project setup,
billing, the bucket, environment variables, why there are no API keys, locking
the URL down, rolling back, cost, and a troubleshooting table.

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
3. **Do the roll call.** The app prompts for it and moves on by itself when the
   introductions stop. Anyone who skips it, or arrives late, will not be named —
   though they can still say their name aloud at any point.
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

## Where everything is stored

One directory per meeting — a meeting is a folder you can zip, inspect or
delete, which is the right shape for recordings of real people.

```
data/meetings/<meeting-id>/
  meta.json          title, attendees, agenda, status, pause marks
  audio.pcm          raw 16 kHz mono PCM, deleted after drafting
  live.jsonl         the rough live transcript, one line per chunk
  digest.jsonl       the rolling summary blocks
  transcript.json    the verbatim diarized transcript (口語 Cantonese)
  speakers.json      voice → name mapping, with the evidence for each
  minutes.json       the structured minutes
  minutes.md         the rendered document
```

Locally that is `./data`. On Cloud Run it is the instance's disk, **which does
not survive the instance** — and with scale-to-zero the instance is reclaimed
between meetings. So with a bucket configured, every document above is mirrored
to `gs://<bucket>/meetings/<id>/` when a stage completes, and restored at boot.
That is what makes scale-to-zero safe rather than lossy.

**Without a bucket, run it locally**, or past meetings will disappear.

### Getting the minutes out

| Format | How | Use |
| --- | --- | --- |
| **Word `.docx`** | Download button, or `GET /api/meetings/<id>/minutes.docx` | The one that matters. Tabled, circulated, put on letterhead, signed. Serif body with 明體 for the Chinese quotes, real tables for the action items. |
| Markdown `.md` | Download button, or `/minutes.md` | Pasting into Notion, Slack, a wiki, git. |
| JSON | `minutes.json` in the meeting folder | Feeding another system. Every resolution, motion and action as structured data with its evidence. |
| Plain text | `/transcript.txt` | The verbatim transcript. |
| Share sheet | "Share minutes" | AirDrop, WhatsApp, email — whatever the phone offers. |

### Retention

The recording lives at `gs://<bucket>/meetings/<id>/audio.wav`.

| `RETAIN_AUDIO_DAYS` | What happens |
| --- | --- |
| `0` | Deleted the moment the minutes are drafted. Strongest posture — you can tell the room the recording does not survive. |
| `30` (default) | Bucket lifecycle rule deletes it after 30 days. |
| `forever` | Kept indefinitely; `deploy.sh` tiers it Nearline at 30d, Coldline at 90d, Archive at 365d. |

Storage genuinely is not the constraint. 16 kHz mono is ~115 MB an hour, so a
two-hour meeting is about half a US cent a month, and a hundred of them roughly
fifty cents — pennies once tiered. The reason to bound it is that these are
recordings of colleagues' voices, and "indefinitely" should be a decision
somebody made rather than a default nobody noticed.

Retention is enforced by the bucket, never by application code: a deletion that
depends on the app remembering to run is a deletion that eventually does not
happen. Only `audio.wav` ages out — minutes and transcripts are always kept.

Whatever you set, the consent announcement on the pre-flight screen reads the
configured value, so it never tells the room something untrue.

## How the audio is referenced

By **seconds from the start of the recording**, and nothing else. There is one
audio file per meeting, so a timestamp is a complete address:

```
transcript segment   { start: 1290.4, end: 1296.1, speaker, text }
summary block        { start: 1200, end: 1500, heading, bullets }
evidence on a claim  { time: 912, quote: "我 second 呢個 motion" }
                              │
                              ▼
        byte offset = seconds × 32000   (16 kHz × 1 channel × 2 bytes)
```

`GET /api/meetings/<id>/clip?at=912&pad=6` reads that byte range — from local
disk, or a ranged read straight out of Cloud Storage — and returns a few seconds
as a standalone WAV. A phone fetches kilobytes, not the 230 MB file.

So every quote in the minutes, and every line of the transcript, has a play
button. That matters because the minutes are in English and the meeting was not:
the English is a translation nobody can check from the page. The quote lets you
check the words; the audio lets you check the quote.

**One caveat.** Timestamps are *recording* seconds, not wall-clock. If you paused
for ten minutes, the timeline compresses and `01:00:00` in the minutes is not an
hour after the meeting started. Consistent everywhere, but worth knowing. The
pause positions are in `meta.json` if you need to map back.

## Pausing

Pause releases the microphone rather than muting the upload, so the phone's
recording indicator goes out and the room can see it has actually stopped —
during a break or an off-the-record aside that matters more than the tokens
saved. Paused time does not exist in the recording, so the timeline compresses;
the pause positions are kept in `meta.json` so a gap is visible rather than two
conversations being silently spliced together.

## The live transcript

It has two jobs, and the second one is easy to overlook.

1. **Mic check.** In the first minute you find out whether the person at the far
   end of the table is being picked up, while you can still move the phone.
2. **Scrollback.** At 01:30 you want to check what was said at 00:30. That is a
   real in-meeting need, and the final transcript does not exist yet.

For (2), scrolling an hour of raw transcript does not actually work — you have
to already know what word to search for. So every five minutes the live
transcript is folded into a **summary block**: a topic heading, two to four
bullets, and any decision that was actually reached. A two hour meeting becomes
about twenty scannable blocks, which is the default view. The raw transcript
sits behind a tab with a search box.

Those blocks are deliberately kept out of the minutes pipeline. They are formed
mid-discussion, before the outcome is known; the minutes are drafted
independently from the complete transcript.

Because of (1) the chunks start short and get longer. Every chunk re-sends the
same language rules, so at 20s the prompt overhead is nearly half the input
tokens. Ramping to 60s after three minutes takes a 2 hour meeting from 360 model
calls to 126, with no gap in coverage and arguably better rewind granularity —
fewer, more coherent blocks.

## Cost

For a **2-hour meeting** on `gemini-3.6-flash`
([$1.50 / $7.50 per 1M tokens](https://evolink.ai/blog/gemini-3-6-flash-release-date)),
audio being ~32 tokens/second:

| Stage | Notes | Approx |
| --- | --- | --- |
| Live pass | 126 chunks after the ramp | $0.66 |
| Full transcript | 230k audio tokens in, long transcript out | $0.57 |
| Rolling summary | ~24 blocks, text only | $0.10 |
| Roll call detection | a few short text calls | $0.01 |
| Speaker ID | text only | $0.03 |
| Minutes | transcript in, document out | $0.09 |
| | | **~$1.45** |

Halve it for a one-hour meeting. Without the chunk ramp the live pass alone
would be $0.85.

The remaining lever is `MODEL_LIVE=gemini-3.5-flash-lite`
([$0.30 / $2.50](https://www.metacto.com/blogs/the-true-cost-of-google-gemini-a-guide-to-api-pricing-and-integration)),
which takes the live pass to about $0.16 and the total to **~$0.85**. The
authoritative transcript still runs on `MODEL_TRANSCRIBE`, so the only thing at
risk is how readable the on-screen scrollback is. Worth testing on a real
meeting rather than assuming.

Context caching would be the obvious fix for the repeated prompt —
[cache reads are 10% of base input](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-context-caching)
— but the repeated block here is only ~450 tokens, below the usual minimum
cacheable size. Not counted above.

Cloud Run scales to zero between meetings, so it costs nothing while idle.
Storage for a retained two-hour recording is about half a cent a month.

### Cold start

Node boots in well under a second; with container start, expect **roughly 2–5
seconds** the first time you open the app after a quiet period. That lands on
the home screen, before you have finished the setup form — by the time you press
Start the instance is warm, and the websocket connects to a running process.

The thing to watch is not the process start but what runs at boot. Because the
disk is empty on every cold start, the app restores from Cloud Storage — and if
that restored every document for every meeting it would get slower with each
meeting ever recorded. So boot restores **only the meeting index** (one small
`meta.json` each, fetched in parallel), and a meeting's transcript and minutes
are pulled down the first time you actually open it.

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
npm test         # 127 assertions, no credentials needed
npm run typecheck
npm run check    # the only thing that talks to Vertex
```

Three suites, none of which touch Vertex:

| Suite | What it exercises |
| --- | --- |
| `units.mjs` | WAV framing byte by byte, sample-boundary offsets, the chunk ramp, the Markdown renderer, and the Word document — inflated from the zip and asserted against parsed XML, because grepping compressed bytes proves nothing about what Word opens. |
| `pipeline.mjs` | The model stubbed out, so everything *downstream* of a Gemini call runs: shifting segment timestamps into meeting time, de-duplicating the overlap seam, carrying speaker labels between segments, rejecting a hallucinated speaker, backfilling the minutes header, and raising a review flag for every unnamed voice, unowned action and unclear vote. |
| `smoke.mjs` | A real server, real HTTP, a real websocket carrying real synthetic PCM. Audio lands on disk to the byte, roll call / pause / resume move the state machine correctly, clips extract at the right offsets, traversal is refused. |

**What none of them can tell you** is whether the prompts work — whether Gemini
keeps Cantonese in 口語, holds speaker labels across two hours, or resists
turning an argument into a decision. That is judgement, not logic, and only a
real recording answers it. That is what `npm run check -- recording.m4a` is for,
and it should be the first thing you run.

## Known limits

- **One meeting at a time.** Not a code limit — the server is per-meeting-id
  throughout and two concurrent meetings would work on one instance. The cap is
  `--max-instances 1`, because audio streams to instance-local disk and a second
  instance could not see the first's recording. Lifting it means streaming audio
  to Cloud Storage instead.
- **Reloading the page mid-meeting loses the session.** The recording on the
  server is safe, but the browser cannot re-attach to it; you would need to stop
  and start a new one.
- **Cloud Run cuts a request at 60 minutes**, and a websocket is one request. A
  longer meeting sees a reconnect on the hour — the client buffers across it, so
  no audio is lost, but you will see the status pill flicker.
- **The queue is capped at ~5 minutes** of buffered audio when the connection
  drops. Longer than that and the oldest audio is discarded rather than killing
  the tab.
- **No auth.** See the privacy note above.
