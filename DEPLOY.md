# Deploying to Google Cloud

Start to finish, about 20 minutes. Most of it is waiting for the first build.

**There are no API keys in this app.** If you are looking for where to paste a
secret, there isn't one — see [Secrets](#secrets) for why, and what to do if you
ever add something that genuinely is one.

---

## Before you start

You need:

- A Google account with **billing enabled** on a Cloud project. Vertex AI will
  not serve requests without it, even inside the free tier.
- The `gcloud` CLI — [install instructions](https://cloud.google.com/sdk/docs/install).
- Node 20 or newer.
- About US$1–2 of Vertex usage per two-hour meeting, plus pennies of storage.
  Cloud Run itself is free while idle.

Check `gcloud` is there:

```bash
gcloud version
```

---

## Step 1 — Pick or create a project

If you already have one, note its **project ID** (not the display name — the ID,
which looks like `minutes-app-472913`):

```bash
gcloud projects list
```

To create a new one:

```bash
gcloud projects create my-minutes-app --name="Minutes"
gcloud config set project my-minutes-app
```

Then link billing. Easiest in the console —
[console.cloud.google.com/billing](https://console.cloud.google.com/billing) →
select the project → link a billing account. Or:

```bash
gcloud billing accounts list
gcloud billing projects link my-minutes-app --billing-account=XXXXXX-XXXXXX-XXXXXX
```

**Verify billing is actually on** before going further, because the failure
later is an opaque permissions error:

```bash
gcloud billing projects describe my-minutes-app
# billingEnabled: true
```

---

## Step 2 — Log in

Two different logins, and both are needed:

```bash
# Lets the gcloud CLI act as you.
gcloud auth login

# Lets code running on your machine call Google APIs as you.
gcloud auth application-default login
```

The second one is what `npm run check` uses. Skipping it is the most common
reason the check fails at step 2 of its own output.

---

## Step 3 — Enable the APIs

`deploy.sh` does this for you, but doing it now surfaces billing problems before
you've waited for a build:

```bash
gcloud services enable \
  run.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  --project my-minutes-app
```

---

## Step 4 — Create a storage bucket

Optional, but do it. Without a bucket:

- Meetings over ~5 minutes are transcribed in segments, and speaker labels drift
  across every seam.
- Nothing survives a Cloud Run restart, and with scale-to-zero that is between
  every meeting. Your history disappears.
- Audio cannot be retained, so the play buttons under each quote never work.

Bucket names are globally unique, so prefix it with your project:

```bash
gcloud storage buckets create gs://my-minutes-app-recordings \
  --location=asia-east2 \
  --uniform-bucket-level-access \
  --project my-minutes-app
```

Pick the location closest to you — `asia-east2` is Hong Kong, `asia-southeast1`
Singapore, `europe-west2` London. Keep it in the same region you deploy to.

---

## Step 5 — Configure locally

```bash
git clone https://github.com/raymondpun/minutes.git
cd minutes
git checkout develop
npm install
cp .env.example .env
```

Edit `.env`. The minimum is one line:

```bash
GOOGLE_CLOUD_PROJECT=my-minutes-app
```

Realistically you want four:

```bash
GOOGLE_CLOUD_PROJECT=my-minutes-app
GOOGLE_CLOUD_LOCATION=asia-east2
GCS_BUCKET=my-minutes-app-recordings
RETAIN_AUDIO_DAYS=30
```

`.env` is git-ignored and is only used when running locally. Cloud Run gets its
configuration separately — see [Step 8](#step-8--deploy).

---

## Step 6 — Prove it can reach Vertex

**Do this before you deploy anything.** It costs a fraction of a cent and turns
the most likely failures into a message with the fix attached.

```bash
npm run check
```

You should see:

```
1. Configuration
  ✓ project my-minutes-app
  ✓ region asia-east2
  ✓ model gemini-3.6-flash
  ✓ audio retention 30 days
  ✓ transcription mode single pass via gs://my-minutes-app-recordings

2. Credentials
  ✓ access token obtained application default credentials

3. Vertex AI
  ✓ gemini-3.6-flash reachable, structured output works
  ✓ gemini-3.6-flash accepts inline audio

4. Cloud Storage
  ✓ gs://my-minutes-app-recordings readable and writable

Ready.
```

Every failure prints the exact command that fixes it. See
[Troubleshooting](#troubleshooting) if one is unclear.

---

## Step 7 — Test with a real recording

Also before deploying. This is the only thing that tells you whether the
transcription actually works on *your* meetings, in Cantonese, with your
colleagues' voices.

Record two minutes on your phone's voice memo app with someone else. Both say
your names at the start, then talk normally — ideally about something with a
number and a decision in it. Then:

```bash
npm run check -- ~/Downloads/test.m4a
```

It prints the transcript with speakers, the name mapping and the evidence behind
it, drafts real minutes to `preflight-minutes.md`, and checks the failure that
hides best — whether the model is quietly rewriting spoken Cantonese
(係 唔係 嘅 咗) into formal 書面語 (是 不是 的 了).

**Read `preflight-minutes.md` before you deploy.** If the Cantonese is being
converted, or names are landing on the wrong person, that is a prompt problem
and no amount of deployment fixes it.

---

## Step 8 — Deploy

```bash
export GCS_BUCKET=my-minutes-app-recordings
export RETAIN_AUDIO_DAYS=30

./deploy.sh my-minutes-app asia-east2
```

The first build takes 5–10 minutes; later ones are 2–3. The script:

1. Enables the APIs
2. Creates a dedicated service account `minutes-run@…` — the app runs as this,
   not as you, and it can call Vertex and touch that bucket and nothing else
3. Grants it `roles/aiplatform.user` and `roles/storage.objectAdmin` on the bucket
4. Sets a **bucket lifecycle rule** matching `RETAIN_AUDIO_DAYS`, so deletion is
   enforced by Cloud Storage rather than by the app remembering to run
5. Builds the container and deploys it
6. Prints your HTTPS URL

Keep that URL. It is unguessable but public — see [Locking it down](#locking-it-down).

---

## Step 9 — Put it on your phone

Open the URL in the phone's browser and add it to the home screen:

- **iPhone:** Share → Add to Home Screen. Must be Safari.
- **Android:** menu → Install app / Add to Home screen.

Running from the home screen matters — it stops the browser chrome stealing taps
mid-meeting.

**iPhone, before a long meeting:** Settings → Display & Brightness → Auto-Lock →
Never. The app takes a wake lock where Safari supports it, but if the screen
locks the audio context suspends and recording stops.

---

## Step 10 — First meeting

Use a low-stakes one. Then:

- Fill in the attendee list on the setup screen. It is the single biggest
  accuracy win available.
- Phone flat in the middle of the table, screen up.
- Watch the live transcript for the first minute. If the person at the far end
  never appears, move the phone — that is the entire reason that screen exists.
- Read the "to verify before sign-off" list at the top of the minutes.

---

## Environment variables

Set on Cloud Run by `deploy.sh` via `--set-env-vars`, and locally by `.env`.
**None of these are secret.**

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | *required* | Which project to bill and call |
| `GOOGLE_CLOUD_LOCATION` | `asia-southeast1` | Vertex region |
| `GCS_BUCKET` | *unset* | Single-pass transcription, durable history, audio retention |
| `RETAIN_AUDIO_DAYS` | `30` | `0` = delete at draft, `N` = N days, `forever` = keep and tier to colder storage |
| `MODEL_TRANSCRIBE` | `gemini-3.6-flash` | The authoritative transcript |
| `MODEL_MINUTES` | `gemini-3.6-flash` | Drafting the minutes |
| `MODEL_LIVE` | `gemini-3.6-flash` | Live transcript. `gemini-3.5-flash-lite` cuts the live pass ~4x |
| `MODEL_DIGEST` | `gemini-3.6-flash` | The rolling summary |
| `LIVE_STEADY_CHUNK_SECONDS` | `60` | Live batching after the mic-check window |
| `DIGEST_INTERVAL_SECONDS` | `300` | How often a summary block is written |
| `ROLL_CALL_MAX_SECONDS` | `240` | Give up waiting for introductions to end |

To change one without redeploying:

```bash
gcloud run services update minutes \
  --region asia-east2 \
  --update-env-vars RETAIN_AUDIO_DAYS=0
```

To see what is currently set:

```bash
gcloud run services describe minutes --region asia-east2 \
  --format='value(spec.template.spec.containers[0].env)'
```

---

## Secrets

**This app has none, by design.**

Vertex AI does not use API keys. It uses **Application Default Credentials**,
which means identity comes from the environment rather than from a string you
paste somewhere:

- **On your machine:** `gcloud auth application-default login` writes a
  credential to `~/.config/gcloud/`. Nothing goes in `.env`.
- **On Cloud Run:** the service runs as the `minutes-run@…` service account that
  `deploy.sh` created. Google injects a token automatically. Nothing is stored.

So there is no key to rotate, no key to leak in a screenshot, and nothing in
this repo would be dangerous if it were public. `.env` holds a project ID, a
region and a bucket name.

### If you ever do add a real secret

Say you add an integration that needs a token. Do **not** put it in
`--set-env-vars`, which is visible to anyone with read access to the service.
Use Secret Manager:

```bash
# Store it
echo -n "the-actual-secret" | gcloud secrets create my-integration-token \
  --data-file=- --project my-minutes-app

# Let the app read it
gcloud secrets add-iam-policy-binding my-integration-token \
  --member="serviceAccount:minutes-run@my-minutes-app.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project my-minutes-app

# Mount it as an env var at deploy time
gcloud run services update minutes --region asia-east2 \
  --set-secrets MY_INTEGRATION_TOKEN=my-integration-token:latest
```

It then appears as `process.env.MY_INTEGRATION_TOKEN` and never touches the repo
or the service config.

---

## Locking it down

`deploy.sh` uses `--allow-unauthenticated`, which means **anyone with the URL can
open the app**. The URL is long and unguessable, so this is not an emergency —
but it is not access control either, and this app holds recordings of your
colleagues.

Options, roughly in order of effort:

1. **Leave it.** Reasonable if you treat the URL as a password and the meetings
   are low sensitivity.
2. **Identity-Aware Proxy** in front of the service, restricted to your Google
   account or Workspace domain. This is the proper answer. It is more setup than
   fits here — see
   [Cloud Run IAP](https://cloud.google.com/iap/docs/enabling-cloud-run).
   Caveat worth knowing before you start: IAP authenticates browser requests,
   and **WebSockets behind IAP need checking** — this app streams audio over
   one, so test a real recording immediately after enabling it.
3. **An access code in the app.** Simplest thing that actually gates it for a
   single user. Not built — ask if you want it.

Whatever you choose, the bucket is already private: `--uniform-bucket-level-access`
means only the service account can read the recordings.

---

## Updating

```bash
git pull
export GCS_BUCKET=my-minutes-app-recordings
./deploy.sh my-minutes-app asia-east2
```

Cloud Run keeps every revision. To roll back:

```bash
gcloud run revisions list --service minutes --region asia-east2

gcloud run services update-traffic minutes \
  --region asia-east2 \
  --to-revisions minutes-00007-abc=100
```

---

## Watching the cost

```bash
# What has been spent
gcloud billing accounts list
```

Then [console.cloud.google.com/billing](https://console.cloud.google.com/billing)
→ Reports → filter by service. Expect Vertex AI to dominate and Cloud Run to be
near zero.

**Set a budget alert** — it takes two minutes and it is the difference between
noticing a runaway loop today or next month:

Billing → Budgets & alerts → Create budget → scope to this project → set an
amount → alert at 50%, 90%, 100%.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm run check` — "Could not load the default credentials" | Step 2 skipped | `gcloud auth application-default login` |
| "PERMISSION_DENIED" on a Vertex call | API off, or the account lacks the role | `gcloud services enable aiplatform.googleapis.com`; grant `roles/aiplatform.user` |
| "Publisher Model … not found" | The model is not served in your region | Try `GOOGLE_CLOUD_LOCATION=us-central1`, or set `MODEL_*` to a model your region has |
| "billing" in the error text | Billing not linked | Link it, then wait a minute |
| Build fails on `gcloud run deploy` | Cloud Build API off | `gcloud services enable cloudbuild.googleapis.com` |
| Microphone button does nothing on the phone | Not a secure context | Use the `https://…run.app` URL, never an IP |
| iPhone stops recording partway | Screen locked | Auto-Lock → Never; do not switch apps |
| Status pill flicks to "Reconnecting" around 60 min | Cloud Run caps a request at 60 min and a WebSocket is one request | Expected. Audio is buffered across it and nothing is lost |
| Meeting stuck on "Transcribing" | Instance was reclaimed while the phone was locked | Reopen the meeting — it restarts and reads the recording back from the bucket |
| Past meetings vanished | No `GCS_BUCKET`, and the instance recycled | Set a bucket and redeploy. Nothing recovers what is already gone |
| Minutes name people "Speaker 2" | Nobody was identified | Check the roll call happened, and fill in the attendee list next time |
| Cantonese comes out as 是/不是/的 | The model drifted to 書面語 | Re-run `npm run check -- recording.m4a` to confirm, then strengthen rule 1 in `server/src/prompts.ts` |

Logs:

```bash
gcloud run services logs read minutes --region asia-east2 --limit 100
```

---

## Tearing it down

```bash
gcloud run services delete minutes --region asia-east2

# Deletes every recording, transcript and set of minutes. Irreversible.
gcloud storage rm -r gs://my-minutes-app-recordings

gcloud iam service-accounts delete \
  minutes-run@my-minutes-app.iam.gserviceaccount.com
```

Or delete the whole project, which stops all billing:

```bash
gcloud projects delete my-minutes-app
```
