#!/usr/bin/env bash
#
# Keeps the Schema Studio running on this server in step with GitHub.
#
# cron runs this every five minutes (deploy/README.md has the line). Most runs
# find nothing new and exit without a word. When `main` on GitHub has a commit
# this copy does not:
#
#   1. It waits until GitHub's CI has passed on that commit, and skips the
#      commit if CI failed. A push that breaks the build or the tests never
#      reaches the server.
#   2. It moves this copy to that commit. Fast-forward only: if someone edited
#      files here by hand, it stops and says so instead of throwing the edits
#      away.
#   3. It rebuilds and restarts the app with docker compose. The database
#      container and its data are not touched. If the build fails, compose
#      leaves the old app running, so a bad deploy never takes the site down.
#   4. It waits for the new app to report healthy, then deletes the old image
#      the rebuild left behind, so the disk does not slowly fill up.
#
# Each event is one timestamped line on stdout (cron sends it to the log file).
# The full build output of the latest deploy is in deploy/last-build.log.
#
# Optional settings, put in front of the command in the crontab line:
#   DEPLOY_BRANCH=main   the branch to follow
#   DEPLOY_SKIP_CI=1     deploy without waiting for CI (not recommended)

set -euo pipefail

# cron starts with an almost empty PATH. Make sure git, docker, curl and
# python3 are found.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK_DIR="$REPO_DIR/.deploy.lock"
STATE_FILE="$REPO_DIR/.deploy-state"
BUILD_LOG="$REPO_DIR/deploy/last-build.log"
cd "$REPO_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }

# Logs a message only if it differs from the last one logged this way. A
# commit that waits twenty minutes for CI then writes one line, not four.
log_once() {
  if [ "$(cat "$STATE_FILE" 2>/dev/null || true)" != "$*" ]; then
    log "$*"
    echo "$*" > "$STATE_FILE"
  fi
}

# One run at a time: a build can take longer than the five minutes between
# runs. mkdir is the lock because it either creates the folder or fails, in one
# step. A lock left behind by a run that died (say, a reboot mid-build) is
# cleared once it is an hour old.
if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +60)" ]; then
  rmdir "$LOCK_DIR"
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
  log_once "This copy is on branch '$current_branch', not '$BRANCH'. Fix with: git checkout $BRANCH"
  exit 1
fi

if ! git fetch --quiet origin "$BRANCH"; then
  log_once "Could not reach GitHub (git fetch failed). Will try again next run."
  exit 1
fi

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
short="${remote_sha:0:7}"

if [ "$local_sha" = "$remote_sha" ]; then
  # Quiet under cron, but a person running it by hand gets an answer.
  if [ -t 1 ]; then echo "Up to date at ${local_sha:0:7}."; fi
  exit 0
fi

# A commit already skipped for failing CI stays skipped until a newer push, so
# don't ask GitHub about it again every five minutes.
if grep -q "^Skipping $short" "$STATE_FILE" 2>/dev/null; then
  exit 0
fi

# Prints success, pending or failed for commit $1, going by every GitHub
# Actions run on it. Anything unexpected (no network, GitHub's hourly limit for
# anonymous callers) prints unknown, and the next run just asks again. The repo
# is public, so no token is needed and none is stored on the server.
ci_state() {
  local slug json
  slug="$(git config --get remote.origin.url | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  json="$(curl -fsS --max-time 20 "https://api.github.com/repos/$slug/actions/runs?head_sha=$1&per_page=50" 2>/dev/null)" \
    || { echo unknown; return; }
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    runs = json.load(sys.stdin)["workflow_runs"]
except Exception:
    print("unknown")
    sys.exit()
if not runs or any(r["status"] != "completed" for r in runs):
    print("pending")  # not started yet, or still running
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs):
    print("success")
else:
    print("failed")
'
}

if [ "${DEPLOY_SKIP_CI:-}" != "1" ]; then
  case "$(ci_state "$remote_sha")" in
    success) ;;
    pending)
      log_once "Found $short on $BRANCH. Waiting for CI to pass before deploying it."
      exit 0 ;;
    failed)
      log_once "Skipping $short: CI failed on it. The next push to $BRANCH will be tried instead."
      exit 0 ;;
    *)
      log_once "Could not ask GitHub about CI for $short. Will try again next run."
      exit 0 ;;
  esac
fi

log "Deploying $short: $(git log -1 --format=%s "$remote_sha")"

if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  log_once "Could not move to $short: files were changed by hand on this server. 'git status' lists them; undo them and the next run retries."
  exit 1
fi

# Build first, then swap. If the build fails, compose never gets to replacing
# the running container. This copy now sits at the new commit, so the same
# broken commit is not rebuilt every five minutes; the next push is.
if ! docker compose up -d --build > "$BUILD_LOG" 2>&1; then
  log "Build of $short FAILED. The previous version is still running. Details: deploy/last-build.log"
  echo "Build failed $short" > "$STATE_FILE"
  exit 1
fi

# The Dockerfile's healthcheck loads /login every 30 seconds. Give it up to
# three minutes to say healthy.
app_id="$(docker compose ps -q app)"
health="starting"
for _ in $(seq 1 36); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$app_id" 2>/dev/null || echo missing)"
  if [ "$health" = healthy ]; then break; fi
  sleep 5
done
if [ "$health" = healthy ]; then
  log "Deployed $short. The app is up and healthy."
else
  log "Deployed $short, but the app is '$health' after 3 minutes. See: docker compose logs app"
fi
echo "Deployed $short" > "$STATE_FILE"

# Each rebuild leaves the previous app image behind with no name. Remove those,
# and build cache older than three days, so the disk stays flat.
docker image prune -f > /dev/null 2>&1 || true
docker builder prune -f --filter until=72h > /dev/null 2>&1 || true
