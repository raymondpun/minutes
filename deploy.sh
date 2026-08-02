#!/usr/bin/env bash
#
# Deploy to Cloud Run.
#
# Cloud Run is not just convenient here -- it is the practical way to run this
# on a phone at all. getUserMedia requires a secure context, so a phone cannot
# use the microphone against http://192.168.x.x. Cloud Run gives you HTTPS with
# a real certificate for free.
#
# Usage:  ./deploy.sh [PROJECT_ID] [REGION]

set -euo pipefail

PROJECT="${1:-${GOOGLE_CLOUD_PROJECT:-}}"
REGION="${2:-${GOOGLE_CLOUD_LOCATION:-europe-west1}}"
SERVICE="minutes"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: ./deploy.sh PROJECT_ID [REGION]" >&2
  exit 1
fi

echo "==> Project $PROJECT / region $REGION"

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  --project "$PROJECT"

# A dedicated identity, so the service can call Vertex and nothing else.
SA="minutes-run@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  echo "==> Creating service account"
  gcloud iam service-accounts create minutes-run \
    --display-name "Minutes (Cloud Run)" \
    --project "$PROJECT"
fi

echo "==> Granting Vertex AI access"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${SA}" \
  --role roles/aiplatform.user \
  --condition None \
  --quiet >/dev/null

ENV_VARS="GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${REGION}"

if [[ -n "${GCS_BUCKET:-}" ]]; then
  echo "==> Granting bucket access (gs://${GCS_BUCKET})"
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
    --member "serviceAccount:${SA}" \
    --role roles/storage.objectAdmin \
    --project "$PROJECT" >/dev/null
  ENV_VARS="${ENV_VARS},GCS_BUCKET=${GCS_BUCKET}"

  RETAIN_DAYS="${RETAIN_AUDIO_DAYS:-30}"
  ENV_VARS="${ENV_VARS},RETAIN_AUDIO_DAYS=${RETAIN_DAYS}"

  LIFECYCLE=$(mktemp)
  if [[ "$RETAIN_DAYS" == "forever" ]]; then
    # Keeping recordings indefinitely is cheap, but only if they are allowed to
    # get colder. Audio nobody has played in a year does not belong in Standard
    # storage at 20x the price of Archive. Minutes and transcripts are tiny and
    # read often, so only audio.wav is tiered.
    echo "==> Recordings kept indefinitely; tiering them to colder storage over time"
    cat > "$LIFECYCLE" <<'JSON'
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "SetStorageClass", "storageClass": "NEARLINE" },
        "condition": { "age": 30, "matchesSuffix": ["audio.wav"] }
      },
      {
        "action": { "type": "SetStorageClass", "storageClass": "COLDLINE" },
        "condition": { "age": 90, "matchesSuffix": ["audio.wav"] }
      },
      {
        "action": { "type": "SetStorageClass", "storageClass": "ARCHIVE" },
        "condition": { "age": 365, "matchesSuffix": ["audio.wav"] }
      }
    ]
  }
}
JSON
    gcloud storage buckets update "gs://${GCS_BUCKET}" \
      --lifecycle-file="$LIFECYCLE" --project "$PROJECT" >/dev/null
  elif [[ "$RETAIN_DAYS" -gt 0 ]]; then
    # Enforce retention at the bucket rather than in application code. A
    # deletion that depends on the app remembering to run is a deletion that
    # eventually does not happen, and this object is a recording of people's
    # voices. Only audio ages out -- minutes and transcripts are kept.
    echo "==> Setting a ${RETAIN_DAYS}-day lifecycle rule on the recordings"
    cat > "$LIFECYCLE" <<JSON
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": {
          "age": ${RETAIN_DAYS},
          "matchesSuffix": ["audio.wav"]
        }
      }
    ]
  }
}
JSON
    gcloud storage buckets update "gs://${GCS_BUCKET}" \
      --lifecycle-file="$LIFECYCLE" --project "$PROJECT" >/dev/null
  fi
  rm -f "$LIFECYCLE"
fi

echo "==> Deploying"
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --service-account "$SA" \
  --set-env-vars "$ENV_VARS" \
  --memory 2Gi \
  --cpu 2 \
  `# Cloud Run caps a single request at 60 minutes, and a websocket is one` \
  `# request. Longer meetings therefore see a reconnect on the hour; the client` \
  `# buffers across it, so no audio is lost.` \
  --timeout 3600 \
  --concurrency 20 \
  `# Scale to zero between meetings -- this is idle almost all the time, and a` \
  `# few seconds of cold start before you press record costs nothing.` \
  --min-instances 0 \
  `# Recordings stream to the instance's local disk, so a meeting must stay on` \
  `# the instance that started it.` \
  --max-instances 1 \
  --session-affinity \
  `# Essential with min-instances 0. By default Cloud Run throttles CPU to` \
  `# near zero once a response is sent, which would freeze the transcription` \
  `# job that runs after you press stop. This keeps the CPU allocated for the` \
  `# life of the instance.` \
  --no-cpu-throttling \
  --allow-unauthenticated

URL=$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --format 'value(status.url)')

cat <<EOF

==> Deployed: $URL

Open that on your phone and add it to the home screen.
  iPhone:  Share -> Add to Home Screen
  Android: menu -> Install app / Add to Home screen

Note --allow-unauthenticated: this URL is public. It is unguessable, but
anyone with the link can record a meeting into your project. Put IAP in
front of it before it holds anything you would not want read aloud.
EOF
