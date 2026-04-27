#!/usr/bin/env bash
set -euo pipefail

REPO="Shivansh123backend/shivansh-backend"
BRANCH="replit-sync"
TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN:?GITHUB_PERSONAL_ACCESS_TOKEN secret not set}"
REMOTE_URL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"
API="https://api.github.com/repos/${REPO}"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json")

mask() { sed "s|${TOKEN}|***|g"; }

echo "==> Deleting old ${BRANCH} (if any)..."
curl -s -o /dev/null -w "  delete: HTTP %{http_code}\n" "${AUTH[@]}" \
  -X DELETE "${API}/git/refs/heads/${BRANCH}" || true

echo "==> Pushing local HEAD to ${BRANCH}..."
GIT_TERMINAL_PROMPT=0 git -c credential.helper= push "${REMOTE_URL}" "HEAD:refs/heads/${BRANCH}" 2>&1 | mask

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_MAIN_SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REMOTE_URL}" main 2>/dev/null | awk '{print $1}')"
echo "==> Local: ${LOCAL_SHA}"
echo "==> Remote main: ${REMOTE_MAIN_SHA}"

if [ "${LOCAL_SHA}" = "${REMOTE_MAIN_SHA}" ]; then
  echo "==> main is already up to date. Nothing to merge."
  exit 0
fi

echo "==> Looking for existing PR from ${BRANCH}..."
PR_NUM="$(curl -s "${AUTH[@]}" "${API}/pulls?head=${REPO%%/*}:${BRANCH}&state=open" | grep -m1 '"number":' | grep -oE '[0-9]+' || true)"

if [ -z "${PR_NUM}" ]; then
  echo "==> Creating PR..."
  PR_RESP="$(curl -s "${AUTH[@]}" -X POST "${API}/pulls" \
    -d "{\"title\":\"Replit sync\",\"head\":\"${BRANCH}\",\"base\":\"main\",\"body\":\"Automated sync from Replit\"}")"
  PR_NUM="$(echo "${PR_RESP}" | grep -m1 '"number":' | grep -oE '[0-9]+' || true)"
  if [ -z "${PR_NUM}" ]; then
    echo "ERROR creating PR:"
    echo "${PR_RESP}" | head -c 500
    exit 1
  fi
fi
echo "==> PR #${PR_NUM}"

echo "==> Merging PR #${PR_NUM}..."
MERGE_RESP="$(curl -s -o /tmp/merge.json -w "%{http_code}" "${AUTH[@]}" \
  -X PUT "${API}/pulls/${PR_NUM}/merge" \
  -d '{"merge_method":"squash"}')"
echo "==> HTTP ${MERGE_RESP}"
cat /tmp/merge.json | head -c 400; echo

if [ "${MERGE_RESP}" = "200" ]; then
  echo "==> Merged. main is now in sync with Replit."
else
  echo "ERROR merging PR. See output above."
  exit 1
fi
