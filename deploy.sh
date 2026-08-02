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
REGION="${2:-${GOOGLE_CLOUD_LOCATION:-asia-southeast1}}"
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
  --timeout 3600 \
  --concurrency 20 \
  `# Keep one instance warm: a cold start in the ten seconds before a meeting` \
  `# begins is exactly when you cannot afford to wait.` \
  --min-instances 1 \
  `# Recordings stream to the instance's local disk, so a meeting must stay on` \
  `# the instance that started it.` \
  --max-instances 1 \
  --session-affinity \
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
