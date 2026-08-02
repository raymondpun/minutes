#!/usr/bin/env bash
#
# One-time setup for keyless deploys from GitHub Actions.
#
# After this runs, a push to main triggers .github/workflows/deploy.yml, which
# authenticates via Workload Identity Federation -- GitHub's OIDC token is
# exchanged directly for GCP credentials, so there is no service-account key
# to store in GitHub, rotate, or leak.
#
# Usage:  ./setup-cicd.sh [PROJECT_ID] [GITHUB_REPO]
#
# Idempotent: every step either creates or confirms.

set -euo pipefail

PROJECT="${1:-${GOOGLE_CLOUD_PROJECT:-ray-minutes-app}}"
REPO="${2:-raymondpun/minutes}"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')
SA="github-deploy@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_SA="minutes-run@${PROJECT}.iam.gserviceaccount.com"

echo "==> Project $PROJECT ($PROJECT_NUMBER), repo $REPO"

echo "==> Deploy service account"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create github-deploy \
    --display-name "GitHub Actions deploy" --project "$PROJECT"

echo "==> APIs for identity federation"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project "$PROJECT"

echo "==> Roles for a source deploy"
# run.admin            deploy the Cloud Run service
# cloudbuild.builds.editor  submit the container build
# storage.admin        upload the source tarball to the run-sources bucket
# viewer               stream Cloud Build logs into the Actions run
for role in roles/run.admin roles/cloudbuild.builds.editor roles/storage.admin roles/viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA}" \
    --role "$role" \
    --condition None --quiet >/dev/null
  echo "    $role"
done

# Deploying a service that runs as minutes-run requires permission to act as it.
echo "==> actAs on the runtime service account"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member "serviceAccount:${SA}" \
  --role roles/iam.serviceAccountUser \
  --project "$PROJECT" --quiet >/dev/null

echo "==> Workload identity pool"
gcloud iam workload-identity-pools describe github \
  --location global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github \
    --location global --display-name "GitHub Actions" --project "$PROJECT"

echo "==> OIDC provider (locked to ${REPO})"
# The attribute condition is the security boundary: only workflows running in
# THIS repository can exchange their token. Without it, any GitHub repo could.
gcloud iam workload-identity-pools providers describe github-oidc \
  --workload-identity-pool github --location global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github-oidc \
    --workload-identity-pool github \
    --location global \
    --project "$PROJECT" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='${REPO}'"

echo "==> Let the repo's workflows impersonate the deploy account"
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --role roles/iam.workloadIdentityUser \
  --project "$PROJECT" --quiet >/dev/null

cat <<EOF

==> Done. The workflow needs these two values (already set in deploy.yml):

  workload_identity_provider: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-oidc
  service_account:            ${SA}

Merge to main and watch the Actions tab.
EOF
