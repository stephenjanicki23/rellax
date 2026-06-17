#!/usr/bin/env bash
# Deploy the betting app to Hugging Face Spaces.
# Run from the repo root: bash betting/deploy.sh
set -euo pipefail

HF_USERNAME="sjanicki23"
SPACE_NAME="sports-betting-edges"
HF_TOKEN="${HF_TOKEN:-}"   # set via env var or will prompt below

if [[ -z "$HF_TOKEN" ]]; then
  read -rsp "Paste your Hugging Face write token: " HF_TOKEN
  echo
fi

SPACE_URL="https://huggingface.co/spaces/${HF_USERNAME}/${SPACE_NAME}"
REPO_URL="https://${HF_USERNAME}:${HF_TOKEN}@huggingface.co/spaces/${HF_USERNAME}/${SPACE_NAME}"

echo "→ Creating Space (safe to re-run if it already exists)..."
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "https://huggingface.co/api/repos/create" \
  -H "Authorization: Bearer ${HF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"${SPACE_NAME}\",\"sdk\":\"gradio\",\"private\":false}" \
  | grep -qE "^(200|409)" || echo "  (Space may already exist, continuing...)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "→ Cloning Space repo..."
git clone --depth 1 "$REPO_URL" "$TMP/space" 2>/dev/null || {
  git init "$TMP/space"
  cd "$TMP/space"
  git remote add origin "$REPO_URL"
  cd - > /dev/null
}

echo "→ Copying app files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rsync -a --exclude='.env' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='deploy.sh' --exclude='tests/' \
  "${SCRIPT_DIR}/" "$TMP/space/"

cd "$TMP/space"
git config user.email "deploy@script"
git config user.name "Deploy Script"
git add -A
git diff --cached --quiet && echo "Nothing to deploy, Space is up to date." && exit 0

git commit -m "Deploy sports betting edge finder"
echo "→ Pushing to Hugging Face..."
git push origin HEAD:main --force

echo ""
echo "✅ Deployed! Your Space is live at:"
echo "   ${SPACE_URL}"
echo ""
echo "⚠️  Add your ODDS_API_KEY secret:"
echo "   ${SPACE_URL}/settings  →  Variables and Secrets"
