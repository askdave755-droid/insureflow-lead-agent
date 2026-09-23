#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# push-to-github.sh — create (optionally) and push this repo to GitHub.
#
# Run from the repo root. The token is never written to disk, never echoed,
# and is stripped from the git remote when the push finishes.
#
#   # push to an existing empty repo
#   GITHUB_TOKEN=ghp_xxx REPO=yourname/insureflow-lead-agent bash push-to-github.sh
#
#   # create the repo first (private), then push
#   GITHUB_TOKEN=ghp_xxx REPO=yourname/insureflow-lead-agent CREATE=1 PRIVATE=1 \
#     bash push-to-github.sh
#
# Token requirements: a fine-grained personal access token with
#   - Contents: Read and write        (to push)
#   - Administration: Read and write  (only if CREATE=1)
# Classic tokens need the "repo" scope.
# ---------------------------------------------------------------------------
set -euo pipefail

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN. Create one at https://github.com/settings/tokens}"
: "${REPO:?Set REPO, e.g. REPO=yourname/insureflow-lead-agent}"
BRANCH="${BRANCH:-main}"
CREATE="${CREATE:-0}"
PRIVATE="${PRIVATE:-1}"

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

cleanup() { git remote set-url origin "https://github.com/${REPO}.git" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$CREATE" = "1" ]; then
  echo "→ creating ${REPO} ($([ "$PRIVATE" = "1" ] && echo private || echo public))…"
  code=$(curl -s -o /tmp/gh-create.json -w "%{http_code}" \
    -X POST "https://api.github.com/user/repos" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"${NAME}\",\"private\":$([ "$PRIVATE" = "1" ] && echo true || echo false),\"description\":\"Lead conversion agent for commercial insurance — qualify, capture, route, and never quote.\"}")
  case "$code" in
    201) echo "  created." ;;
    422) echo "  already exists — continuing." ;;
    401|403) echo "  auth/permission problem (HTTP $code). Check the token scopes."; exit 1 ;;
    *) echo "  unexpected HTTP $code:"; cat /tmp/gh-create.json; exit 1 ;;
  esac
fi

echo "→ staging and committing any changes…"
git add -A
git diff --cached --quiet || git commit -q -m "chore: update before push"

echo "→ pushing ${BRANCH}…"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${REPO}.git"
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
git push -u origin "${BRANCH}"

echo "→ verifying the remote matches local HEAD…"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git ls-remote origin "refs/heads/${BRANCH}" | cut -f1)
[ "$LOCAL" = "$REMOTE" ] && echo "  remote is at ${LOCAL:0:7}" || { echo "  MISMATCH local=$LOCAL remote=$REMOTE"; exit 1; }

echo
echo "Done → https://github.com/${REPO}"
echo "The token has been removed from the local git remote."
