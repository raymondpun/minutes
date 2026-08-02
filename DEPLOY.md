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
- [Part 3 — Prove it works](#part-3--prove-it-works)
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
  --location=asia-east2 \
  --uniform-bucket-level-access
```

Pick the region closest to you and **use the same one throughout**:
`asia-east2` Hong Kong · `asia-southeast1` Singapore · `europe-west2` London ·
`us-central1` Iowa.

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

## 2.2 Install dependencies

```bash
npm install
```

Two or three minutes on Cloud Shell's connection.

## 2.3 Deploy

```bash
export GCS_BUCKET=ray-minutes-app-recordings
export RETAIN_AUDIO_DAYS=30

./deploy.sh ray-minutes-app asia-east2
```

First build is 5–10 minutes; later ones 2–3. Cloud Shell will ask you to
**authorise** the first `gcloud` call that needs it — click Authorize.

The script does all of this so you don't have to:

1. Enables any APIs still missing
2. Creates a dedicated service account `minutes-run@…`. **The app runs as this,
   not as you** — it can call Vertex and touch that one bucket, nothing else.
3. Grants it `roles/aiplatform.user` and `roles/storage.objectAdmin` on the bucket
4. Sets a **bucket lifecycle rule** matching `RETAIN_AUDIO_DAYS`, so deleting
   old recordings is enforced by Cloud Storage rather than by the app
   remembering to do it
5. Builds the container and deploys it
6. Prints your HTTPS URL

Keep that URL. It is unguessable but public — see
[Locking it down](#locking-it-down).

---

# Part 3 — Prove it works

Still in Cloud Shell. **This is the first time any of this code touches Vertex.**

## 3.1 Check the connection

Create a local config so the check knows which project to use:

```bash
cat > .env <<'EOF'
GOOGLE_CLOUD_PROJECT=ray-minutes-app
GOOGLE_CLOUD_LOCATION=asia-east2
GCS_BUCKET=ray-minutes-app-recordings
RETAIN_AUDIO_DAYS=30
EOF

npm run check
```

Expect:

```
1. Configuration
  ✓ project ray-minutes-app
  ✓ region asia-east2
  ✓ model gemini-3.6-flash
  ✓ audio retention 30 days
  ✓ transcription mode single pass via gs://ray-minutes-app-recordings

2. Credentials
  ✓ access token obtained application default credentials

3. Vertex AI
  ✓ gemini-3.6-flash reachable, structured output works
  ✓ gemini-3.6-flash accepts inline audio

4. Cloud Storage
  ✓ gs://ray-minutes-app-recordings readable and writable

Ready.
```

Costs a fraction of a cent. Every failure prints the command that fixes it.

> If step 2 fails in Cloud Shell, run `gcloud auth application-default login`
> and follow the browser flow, then try again.

**If `gemini-3.6-flash` is not served in your region**, the check says so. Fix
it without redeploying:

```bash
gcloud run services update minutes --region asia-east2 \
  --update-env-vars GOOGLE_CLOUD_LOCATION=us-central1
```

## 3.2 Check the transcription — the one that matters

Everything above proves the plumbing. This proves the *product*: whether the
model actually holds spoken Cantonese, and whether it maps voices to names.

Record two minutes on your phone's voice memo app with a colleague. Both say
your names at the start, then talk normally — ideally about something with a
number and a decision in it.

Upload it to Cloud Shell: **⋮ menu (top right of the terminal) → Upload → File**.
It lands in your home directory.

```bash
npm run check -- ~/test.m4a
```

This prints the transcript with speakers, the name mapping and the evidence
behind each one, drafts real minutes to `preflight-minutes.md`, and checks the
failure that hides best — whether the model is quietly rewriting spoken
Cantonese (係 唔係 嘅 咗) into formal 書面語 (是 不是 的 了).

```bash
cat preflight-minutes.md
```

**Read it before you trust the app with a real meeting.** If the Cantonese is
being converted, or a name landed on the wrong person, that is a prompt problem
and deploying again will not fix it.

---

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
  --region=asia-east2
```

You will be sent to the console once to **connect the GitHub repository** and
install the Cloud Build GitHub App. The repo needs a `cloudbuild.yaml` — not
present yet; ask and I'll add one.

Until then, updating is Part 2 again:

```bash
cd ~/minutes && git pull
export GCS_BUCKET=ray-minutes-app-recordings
./deploy.sh ray-minutes-app asia-east2
```

---

# Environment variables

Set on Cloud Run by `deploy.sh` via `--set-env-vars`. **None are secret.**

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | *required* | Which project to bill and call |
| `GOOGLE_CLOUD_LOCATION` | `asia-southeast1` | Vertex region |
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
gcloud run services update minutes --region asia-east2 \
  --update-env-vars RETAIN_AUDIO_DAYS=0
```

See what is currently set:

```bash
gcloud run services describe minutes --region asia-east2 \
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
gcloud run services update minutes --region asia-east2 \
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
./deploy.sh ray-minutes-app asia-east2
```

Cloud Run keeps every revision:

```bash
gcloud run revisions list --service minutes --region asia-east2

gcloud run services update-traffic minutes --region asia-east2 \
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
| "Publisher Model … not found" | Model not served in that region | `--update-env-vars GOOGLE_CLOUD_LOCATION=us-central1` |
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
gcloud run services logs read minutes --region asia-east2 --limit 100
```

---

# Tearing it down

```bash
gcloud run services delete minutes --region asia-east2

# Deletes every recording, transcript and set of minutes. Irreversible.
gcloud storage rm -r gs://ray-minutes-app-recordings

gcloud iam service-accounts delete \
  minutes-run@ray-minutes-app.iam.gserviceaccount.com
```

Or delete the project, which stops all billing:

```bash
gcloud projects delete ray-minutes-app
```
