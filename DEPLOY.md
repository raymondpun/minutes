# Deploying to Google Cloud

Start to finish, about 25 minutes. Most of it is waiting for the first build.

**You do not need to install anything.** The whole deployment runs in Cloud
Shell — a terminal in your browser with `gcloud`, Node and git already there,
already signed in as you. Nothing is cloned to your laptop and nothing is
installed on it.

**There are no API keys in this app.** If you are looking for where to paste a
secret, there isn't one — see [Secrets](#secrets) for why.

---

## Contents

- [Part 1 — Set up the project](#part-1--set-up-the-project) *(console + Cloud Shell)*
- [Part 2 — Deploy](#part-2--deploy) *(Cloud Shell)*
- [Part 3 — Prove it works](#part-3--prove-it-works) *(no terminal needed)*
- [Part 4 — Put it on your phone](#part-4--put-it-on-your-phone)
- [Part 5 — Deploy automatically on every push](#part-5--deploy-automatically-on-every-push) *(optional)*
- [Environment variables](#environment-variables)
- [Secrets](#secrets)
- [Locking it down](#locking-it-down)
- [Updating and rolling back](#updating-and-rolling-back)
- [Watching the cost](#watching-the-cost)
- [Troubleshooting](#troubleshooting)
- [Tearing it down](#tearing-it-down)

---

# Part 1 — Set up the project

## 1.1 Create the project

If you already ran `gcloud projects create`, you have this. Otherwise, easiest
in the console: [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).

Note the **project ID** (like `ray-minutes-app`), not the display name.

> **"My project isn't in `gcloud projects list`"** — normal. That list is
> eventually consistent and lags by a minute or two after creation. Confirm it
> exists with `gcloud projects describe ray-minutes-app`, which is immediate.
>
> **"lacks an 'environment' tag"** — advisory, not an error. Ignore it.

## 1.2 Link billing — and verify it

Do this in the console:
[console.cloud.google.com/billing](https://console.cloud.google.com/billing) →
select the project → link a billing account.

**Verify it actually took.** In Cloud Shell (see 1.3) or anywhere with gcloud:

```bash
gcloud billing projects describe ray-minutes-app
```

You need `billingEnabled: true`. Be fussy here: **Vertex serves nothing without
billing**, and the failure later is an opaque `PERMISSION_DENIED` that looks
like an IAM problem. Two minutes now saves half an hour chasing the wrong thing.

## 1.3 Open Cloud Shell

Go to **[shell.cloud.google.com](https://shell.cloud.google.com)**, or click the
`>_` icon in the top right of any Google Cloud console page.

You get a terminal in the browser, already authenticated as your Google account,
with `gcloud`, `git`, Node and npm installed. It has a 5 GB home directory that
persists between sessions.

Set your project:

```bash
gcloud config set project ray-minutes-app
```

## 1.4 Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com
```

Takes a minute. If this errors about billing, go back to 1.2.

## 1.5 Create the storage bucket

Optional, but do it. Without a bucket:

- Meetings over ~5 minutes are transcribed in segments, and speaker labels drift
  across every seam.
- **Nothing survives a restart**, and with scale-to-zero that is between every
  meeting. Your history disappears.
- Audio cannot be retained, so the play buttons under each quote never work.

Bucket names are globally unique, so prefix with your project ID:

```bash
gcloud storage buckets create gs://ray-minutes-app-recordings \
  --location=europe-west1 \
  --uniform-bucket-level-access
```

Use the same region for the bucket and the service. **Vertex is configured
separately** — see [Two locations, not one](#two-locations-not-one).

---

# Part 2 — Deploy

All of this is in Cloud Shell.

## 2.1 Get the code

The repository is private, so Cloud Shell needs permission to read it.

```bash
gh auth login
```

Choose **GitHub.com** → **HTTPS** → **Login with a web browser**, and follow the
code it gives you. Then:

```bash
gh repo clone raymondpun/minutes -- -b develop
cd minutes
```

<details>
<summary>If <code>gh</code> is unavailable</summary>

Create a personal access token at
[github.com/settings/tokens](https://github.com/settings/tokens) with `repo`
scope, then:

```bash
git clone -b develop https://github.com/raymondpun/minutes.git
# Username: your github username
# Password: paste the token (not your GitHub password)
```
</details>

> **The code is on `develop`, not `main`.** `main` is an empty commit that only
> exists as a pull-request base. The `-b develop` above is not optional.

## 2.2 Deploy

**No `npm install`. Nothing is built here.**

`deploy.sh` runs `gcloud run deploy --source .`, which tars this directory,
sends it to **Cloud Build**, and the container is built there from the
`Dockerfile` — which runs `npm ci` inside the image. Cloud Shell is only doing
the upload. (`.gcloudignore` keeps `node_modules`, `data/` and `.env` out of
that upload.)

```bash
export GCS_BUCKET=ray-minutes-app-recordings
export RETAIN_AUDIO_DAYS=30

./deploy.sh ray-minutes-app europe-west1
```

The second argument is the **Cloud Run region** — where the container and the
bucket live. Vertex is separate and defaults to the global endpoint; see below.

First build 5–10 minutes; later ones 2–3. Cloud Shell will ask you to
**Authorize** the first `gcloud` call — click it.

The script:

1. Enables any APIs still missing
2. Creates a service account `minutes-run@…`. **The app runs as this, not as
   you** — it can call Vertex and touch that one bucket, nothing else
3. Grants it `roles/aiplatform.user` and `roles/storage.objectAdmin` on the bucket
4. Sets a **bucket lifecycle rule** matching `RETAIN_AUDIO_DAYS`, so deleting old
   recordings is enforced by Cloud Storage rather than by the app remembering to
5. Passes the configuration to the service with `--set-env-vars`
6. Builds and deploys
7. Prints your HTTPS URL

## 2.3 Two locations, not one

These are different settings and conflating them will bite you:

| | Value | What it controls |
| --- | --- | --- |
| **Cloud Run region** | `europe-west1` | Where the container runs and the bucket lives. Must be a real region. |
| **`GOOGLE_CLOUD_LOCATION`** | `global` | Where Vertex serves the model from. |

**Why they differ.** `gemini-3.6-flash` is offered on Vertex's **global
endpoint**, not through EU multi-region endpoints. And `global` is not a valid
Cloud Run region, so one variable cannot be both — `deploy.sh` keeps them apart.

**The trade-off, stated plainly.** Your service and your recordings stay in
`europe-west1`. Inference on the global endpoint **may happen outside the EU**.
If you chose Belgium for data residency rather than latency, that matters.

To keep inference in region instead, at the cost of an older model:

```bash
gcloud run services update minutes --region europe-west1 \
  --update-env-vars GOOGLE_CLOUD_LOCATION=europe-west1,MODEL_TRANSCRIBE=gemini-3.5-flash,MODEL_MINUTES=gemini-3.5-flash,MODEL_LIVE=gemini-3.5-flash,MODEL_DIGEST=gemini-3.5-flash
```

`gemini-3.5-flash` has EU deployments. You cannot currently have both the newest
model and EU-only processing — pick which one you need.

## 2.4 Where the configuration actually lives

There are two separate channels, and confusing them is the easiest mistake here:

| | Read by | Set how | Reaches Cloud Run? |
| --- | --- | --- | --- |
| **Service env vars** | the deployed app | `--set-env-vars` in `deploy.sh`, or `gcloud run services update` | **Yes — this is the real config** |
| **`.env` file** | `npm run check` / `npm run dev` on whatever machine you are sitting at | editing the file | **No.** Excluded by `.gcloudignore` |

So the parameters are set **on the Cloud Run instance**, by `deploy.sh`. You do
not need a `.env` at all to run the service.

See what the service is actually running with:

```bash
gcloud run services describe minutes --region europe-west1 \
  --format='value(spec.template.spec.containers[0].env)'
```

Change one without redeploying — this restarts the service with the new value:

```bash
gcloud run services update minutes --region europe-west1 \
  --update-env-vars RETAIN_AUDIO_DAYS=0
```

---

# Part 3 — Prove it works

## 3.1 Confirm the config landed

```bash
URL=$(gcloud run services describe minutes --region europe-west1 --format='value(status.url)')
curl -s $URL/api/health
```

```json
{
  "ok": true,
  "project": "ray-minutes-app",
  "location": "global",
  "models": { "transcribe": "gemini-3.6-flash", ... },
  "singlePassTranscription": true,
  "retainAudioDays": 30
}
```

`singlePassTranscription: true` means it found your bucket. If that says
`false`, `GCS_BUCKET` did not reach the service — re-export it and redeploy.

## 3.2 Run a two-minute test meeting

**This is the real test, and it needs no terminal.** Open the URL on your phone,
and record a two-minute meeting with a colleague. Both say your names at the
start, then talk normally — ideally about something with a number and a decision
in it. Press stop and read what comes out.

That exercises the entire path — microphone, streaming, live transcription,
roll-call detection, diarization, speaker naming, drafting — in exactly the
conditions a real meeting will. Nothing simulated.

**What to look at in the result:**

- Is the Cantonese written as spoken (係 唔係 嘅 咗), or converted to 書面語
  (是 不是 的 了)? The second is a prompt problem, and it destroys the
  transcript's value as evidence.
- Did each voice get the right name?
- Does the "to verify before sign-off" list make sense?

**Do this before a meeting that matters.** It is the only thing that tells you
whether the model actually holds Cantonese on your voices, in your room.

## 3.3 If something fails — the diagnostic script

Only needed when 3.1 or 3.2 goes wrong. This one *does* run Node locally, which
is why it needs `npm install` and a `.env`:

```bash
npm install

cat > .env <<'EOF'
GOOGLE_CLOUD_PROJECT=ray-minutes-app
GOOGLE_CLOUD_LOCATION=europe-west1
GCS_BUCKET=ray-minutes-app-recordings
EOF

npm run check
```

It isolates each layer separately — credentials, model reachable in your region,
structured output honoured, audio input accepted, bucket readable and writable —
and prints the exact command to fix whichever one failed. Costs a fraction of a
cent.

To debug transcription quality specifically, upload a recording via the
terminal's **⋮ menu → Upload → File** and run:

```bash
npm run check -- ~/test.m4a
cat preflight-minutes.md
```

That prints the transcript, the name mapping with its evidence, and counts
colloquial Cantonese against 書面語 so drift shows up as a number rather than a
hunch.

# Part 4 — Put it on your phone

Open the URL from 2.3 in the phone's browser and add it to the home screen:

- **iPhone:** Share → Add to Home Screen. Must be Safari.
- **Android:** menu → Install app / Add to Home screen.

Running from the home screen stops browser chrome stealing taps mid-meeting.

**iPhone, before a long meeting:** Settings → Display & Brightness → Auto-Lock →
Never. The app takes a wake lock where Safari supports it, but if the screen
locks, iOS suspends the audio context and recording stops.

**First meeting — use a low-stakes one:**

- Fill in the attendee list on the setup screen. Biggest accuracy win available.
- Phone flat in the middle of the table, screen up.
- Watch the live transcript for the first minute. If the person at the far end
  never appears, move the phone — that is the entire reason that screen exists.
- Read the "to verify before sign-off" list at the top of the minutes.

---

# Part 5 — Deploy automatically on every push

Optional. After this, pushing to `develop` redeploys with no terminal at all.

```bash
gcloud builds triggers create github \
  --name=minutes-deploy \
  --repo-name=minutes \
  --repo-owner=raymondpun \
  --branch-pattern='^develop$' \
  --build-config=cloudbuild.yaml \
  --region=europe-west1
```

You will be sent to the console once to **connect the GitHub repository** and
install the Cloud Build GitHub App. The repo needs a `cloudbuild.yaml` — not
present yet; ask and I'll add one.

Until then, updating is Part 2 again — still no `npm install`:

```bash
cd ~/minutes && git pull
export GCS_BUCKET=ray-minutes-app-recordings
./deploy.sh ray-minutes-app europe-west1
```

---

# Environment variables

Set on Cloud Run by `deploy.sh` via `--set-env-vars`. **None are secret.**

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | *required* | Which project to bill and call |
| `GOOGLE_CLOUD_LOCATION` | `global` | Where **Vertex** serves the model. Not the Cloud Run region |
| `CLOUD_RUN_REGION` | `europe-west1` | Where the container and bucket live. Set as `deploy.sh`'s second argument |
| `GCS_BUCKET` | *unset* | Single-pass transcription, durable history, audio retention |
| `RETAIN_AUDIO_DAYS` | `30` | `0` = delete at draft · `N` = N days · `forever` = keep, tiered to colder storage |
| `MODEL_TRANSCRIBE` | `gemini-3.6-flash` | The authoritative transcript |
| `MODEL_MINUTES` | `gemini-3.6-flash` | Drafting the minutes |
| `MODEL_LIVE` | `gemini-3.6-flash` | Live transcript. `gemini-3.5-flash-lite` cuts that pass ~4x |
| `MODEL_DIGEST` | `gemini-3.6-flash` | The rolling summary |
| `LIVE_STEADY_CHUNK_SECONDS` | `60` | Live batching after the mic-check window |
| `DIGEST_INTERVAL_SECONDS` | `300` | How often a summary block is written |
| `ROLL_CALL_MAX_SECONDS` | `240` | Give up waiting for introductions to end |

Change one without redeploying:

```bash
gcloud run services update minutes --region europe-west1 \
  --update-env-vars RETAIN_AUDIO_DAYS=0
```

See what is currently set:

```bash
gcloud run services describe minutes --region europe-west1 \
  --format='value(spec.template.spec.containers[0].env)'
```

---

# Secrets

**This app has none, by design.**

Vertex AI does not use API keys. It uses **Application Default Credentials**,
so identity comes from the environment rather than a string you paste:

- **In Cloud Shell:** your own Google login, already present.
- **On Cloud Run:** the `minutes-run@…` service account `deploy.sh` created.
  Google injects a token automatically. Nothing is stored anywhere.

There is no key to rotate, none to leak in a screenshot, and nothing in this
repo would be dangerous if it were public. `.env` holds a project ID, a region,
a bucket name and a number.

### If you ever do add a real secret

Say you add an integration needing a token. Do **not** put it in
`--set-env-vars`, which is readable by anyone with access to the service.

```bash
# Store it
echo -n "the-actual-secret" | gcloud secrets create my-integration-token \
  --data-file=-

# Let the app read it
gcloud secrets add-iam-policy-binding my-integration-token \
  --member="serviceAccount:minutes-run@ray-minutes-app.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Mount it as an env var
gcloud run services update minutes --region europe-west1 \
  --set-secrets MY_INTEGRATION_TOKEN=my-integration-token:latest
```

It appears as `process.env.MY_INTEGRATION_TOKEN` and never touches the repo or
the service config.

---

# Locking it down

`deploy.sh` uses `--allow-unauthenticated`, so **anyone with the URL can open the
app**. The URL is long and unguessable, so this is not an emergency — but it is
not access control either, and this app holds recordings of your colleagues.

1. **Leave it.** Reasonable if you treat the URL as a password and the meetings
   are low sensitivity.
2. **Identity-Aware Proxy**, restricted to your Google account or Workspace
   domain. The proper answer —
   [Cloud Run IAP](https://cloud.google.com/iap/docs/enabling-cloud-run).
   **Test a real recording immediately after enabling it:** IAP authenticates
   browser requests, and this app streams audio over a long-lived WebSocket.
   That combination needs verifying, and I have not been able to verify it.
3. **An access code in the app.** Simplest thing that genuinely gates it for one
   user. Not built — ask if you want it.

The bucket is already private either way: `--uniform-bucket-level-access` means
only the service account can read the recordings.

---

# Updating and rolling back

```bash
cd ~/minutes && git pull
export GCS_BUCKET=ray-minutes-app-recordings
./deploy.sh ray-minutes-app europe-west1
```

Cloud Run keeps every revision:

```bash
gcloud run revisions list --service minutes --region europe-west1

gcloud run services update-traffic minutes --region europe-west1 \
  --to-revisions minutes-00007-abc=100
```

---

# Watching the cost

Expect **~US$1.45 of Vertex per two-hour meeting**. Cloud Run scales to zero, so
it costs nothing while idle. Storage is about half a cent per retained meeting
per month.

[console.cloud.google.com/billing](https://console.cloud.google.com/billing) →
Reports → filter by project.

**Set a budget alert.** Two minutes, and it's the difference between noticing a
runaway loop today or next month: Billing → Budgets & alerts → Create budget →
scope to this project → alert at 50%, 90%, 100%.

---

# Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Project missing from `gcloud projects list` | The list index lags | `gcloud projects describe <id>` — if ACTIVE, carry on |
| "lacks an 'environment' tag" | Advisory org nudge | Ignore |
| `PERMISSION_DENIED` on any Vertex call | Billing not linked, or API off | `gcloud billing projects describe <id>` must say `billingEnabled: true` |
| "Could not load the default credentials" | ADC missing | `gcloud auth application-default login` |
| "Publisher Model … not found" | Model not served at that location | `GOOGLE_CLOUD_LOCATION=global` (default), or pin to a region and use a model served there — see [2.3](#23-two-locations-not-one) |
| `Invalid region "global"` from gcloud | Passing the Vertex location where a Cloud Run region belongs | They are separate — `deploy.sh <project> <cloud-run-region>` |
| Build fails immediately | Cloud Build or Artifact Registry API off | `gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com` |
| `git clone` asks for a password and rejects it | GitHub wants a token, not a password | `gh auth login`, or use a PAT |
| Cloned repo looks empty | You are on `main`, which is an empty commit | `git checkout develop` |
| Microphone button does nothing on the phone | Not a secure context | Use the `https://…run.app` URL, never an IP |
| iPhone stops recording partway | Screen locked | Auto-Lock → Never; don't switch apps |
| Status pill flicks to "Reconnecting" near 60 min | Cloud Run caps a request at 60 min; a WebSocket is one request | Expected. Audio buffers across it, nothing is lost |
| Meeting stuck on "Transcribing" | Instance reclaimed while the phone was locked | Reopen the meeting — it restarts and reads the recording back from the bucket |
| Past meetings vanished | No `GCS_BUCKET`, instance recycled | Set a bucket and redeploy. Nothing recovers what is already gone |
| Minutes name people "Speaker 2" | Nobody was identified | Check the roll call happened; fill in the attendee list next time |
| Cantonese comes out as 是/不是/的 | Model drifted to 書面語 | Confirm with `npm run check -- recording.m4a`, then strengthen rule 1 in `server/src/prompts.ts` |

Logs:

```bash
gcloud run services logs read minutes --region europe-west1 --limit 100
```

---

# Tearing it down

```bash
gcloud run services delete minutes --region europe-west1

# Deletes every recording, transcript and set of minutes. Irreversible.
gcloud storage rm -r gs://ray-minutes-app-recordings

gcloud iam service-accounts delete \
  minutes-run@ray-minutes-app.iam.gserviceaccount.com
```

Or delete the project, which stops all billing:

```bash
gcloud projects delete ray-minutes-app
```
