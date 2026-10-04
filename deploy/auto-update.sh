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
#   2. It moves this copy to that commit. If someone edited files here by hand,
#      it stops and says so instead: the edit would be built into the app, and
#      the server would run code that is not on GitHub.
#   3. It rebuilds the app and swaps it in with docker compose. If the build
#      fails, the old app keeps running and the commit is tried again on the
#      next run, three tries in all. The database keeps its data throughout.
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
# python3 are found, /snap/bin included in case Docker came as a snap.
export PATH="/usr/local/bin:/usr/bin:/bin:/snap/bin:${PATH:-}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK_DIR="$REPO_DIR/.deploy.lock"
STATE_FILE="$REPO_DIR/.deploy-state"
SKIP_FILE="$REPO_DIR/.deploy-skipped"
BUILD_LOG="$REPO_DIR/deploy/last-build.log"
cd "$REPO_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }

# Logs a message only if it differs from the last one logged this way. A
# commit that waits twenty minutes for CI then writes one line, not four. A
# person running this by hand still sees the message every time.
log_once() {
  if [ "$(cat "$STATE_FILE" 2>/dev/null || true)" != "$*" ]; then
    log "$*"
    echo "$*" > "$STATE_FILE"
  elif [ -t 1 ]; then
    log "$*"
  fi
}

# Gives up on the commit being looked at until the next push, and says why.
skip() {
  log_once "Skipping $short: $*"
  echo "Skipping $short: $*" > "$SKIP_FILE"
}

# One run at a time: a build can take longer than the five minutes between
# runs. mkdir is the lock because it either creates the folder or fails, in one
# step. A lock left behind by a run that died (say, a reboot mid-build) is
# cleared once it is an hour old.
if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +60)" ]; then
  rmdir "$LOCK_DIR"
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -t 1 ]; then echo "Another run is already going. Try again in a few minutes."; fi
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
  log_once "This copy is on branch '$current_branch', not '$BRANCH'. Fix with: git checkout $BRANCH"
  exit 1
fi

# Git's own error is left out of the log: it changes from run to run (it counts
# milliseconds), so an hour without network would fill the log with it.
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  log_once "Could not reach GitHub, will try again next run. To see why: cd $REPO_DIR && git fetch"
  exit 1
fi
# GitHub answered, so an outage logged earlier is over. Say so, and forget it:
# if the network goes down again later, that is news and gets logged again.
if grep -q "^Could not reach GitHub" "$STATE_FILE" 2>/dev/null; then
  log "Reached GitHub again."
  rm -f "$STATE_FILE"
fi

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
short="${remote_sha:0:7}"

if [ "$local_sha" = "$remote_sha" ]; then
  # Nothing is waiting, so forget any earlier problem. If it comes back, it is
  # news again and gets logged again.
  echo "Up to date at ${local_sha:0:7}" > "$STATE_FILE"
  # Quiet under cron, but a person running it by hand gets an answer.
  if [ -t 1 ]; then echo "Up to date at ${local_sha:0:7}."; fi
  exit 0
fi

# A commit already skipped (CI failed on it, or it failed to deploy three
# times) stays skipped until a newer push, so don't ask GitHub about it again
# every five minutes. The skip is kept in a file of its own because
# .deploy-state changes with every new message: a network outage would wipe
# it, and the commit would be built all over again.
if grep -q "^Skipping $short" "$SKIP_FILE" 2>/dev/null; then
  if [ -t 1 ]; then cat "$SKIP_FILE"; fi
  exit 0
fi

# A hand edit here would be built into the app, so the server would run code
# that is not on GitHub. Stop and say so instead. Only files git tracks count:
# .env and the files this script writes are not tracked.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log_once "Not deploying $short: files in $REPO_DIR were changed by hand. 'git status' there lists them, and 'git checkout -- .' there undoes them. The next run then carries on."
  exit 1
fi

# Prints success, pending or failed for commit $1, going by the GitHub Actions
# runs that a push to $BRANCH started on it. Runs on other branches and on pull
# requests are left out: the same commit is often pushed to several branches,
# and a run cancelled on one of those must not block the deploy here. Anything
# unexpected (no network, GitHub's hourly limit for anonymous callers) prints
# unknown, and the next run just asks again. The repo is public, so no token is
# needed and none is stored on the server.
ci_state() {
  local slug json
  slug="$(git config --get remote.origin.url | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  json="$(curl -fsS --max-time 20 "https://api.github.com/repos/$slug/actions/runs?head_sha=$1&branch=$BRANCH&event=push&per_page=50" 2>/dev/null)" \
    || { echo unknown; return; }
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    runs = json.load(sys.stdin)["workflow_runs"]
except Exception:
    print("unknown")
    sys.exit()
# Only the newest run of each workflow counts. An older one may have been
# cancelled because the same commit was pushed to the branch a second time.
newest = {}
for r in runs:
    w = r["workflow_id"]
    if w not in newest or r["created_at"] > newest[w]["created_at"]:
        newest[w] = r
runs = list(newest.values())
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
      skip "CI failed on it. The next push to $BRANCH will be tried instead."
      exit 0 ;;
    *)
      log_once "Could not ask GitHub about CI for $short. Will try again next run."
      exit 0 ;;
  esac
fi

log "Deploying $short: $(git log -1 --format=%s "$remote_sha")"

# Normally main has only moved forward since the last deploy. If this copy is
# on a commit GitHub does not have (main was force-pushed, or someone committed
# here), follow GitHub anyway. The check above already made sure no hand edits
# are in the way.
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  log "This copy was on ${local_sha:0:7}, which is not part of $BRANCH on GitHub (a force-push there, or a commit made here). Following GitHub."
fi
# --keep moves this copy to the new commit, and refuses rather than overwrite
# anything that is in the way.
if ! reset_error="$(git reset --quiet --keep "origin/$BRANCH" 2>&1)"; then
  log_once "Could not move to $short. Git said: $reset_error"
  exit 1
fi

# Called when the build or the swap below fails. It puts this copy back on the
# commit it came from, so the next run sees the new commit as new again and
# retries it: a build can fail for a reason that passes on its own, like npm or
# Docker Hub being down for a minute. After three tries the commit is skipped
# until the next push. $1 says what happened.
deploy_failed() {
  git reset --quiet --keep "$local_sha"
  local tries=1
  case "$(cat "$STATE_FILE" 2>/dev/null || true)" in
    "Deploy of $short failed (try 1 of 3)"*) tries=2 ;;
    "Deploy of $short failed (try 2 of 3)"*) tries=3 ;;
  esac
  if [ "$tries" -lt 3 ]; then
    log_once "Deploy of $short failed (try $tries of 3). $1 Details: deploy/last-build.log"
  else
    skip "it failed to deploy 3 times. $1 Details: deploy/last-build.log"
  fi
  exit 1
}

# Build first, then swap. A failed build never touches the running app.
if ! docker compose build > "$BUILD_LOG" 2>&1; then
  deploy_failed "The build failed, so the previous version is still running."
fi
# compose replaces the app container with the new build. It recreates the
# database container only if its settings in docker-compose.yml changed, and
# the data lives in a volume, so it is kept either way.
if ! docker compose up -d >> "$BUILD_LOG" 2>&1; then
  deploy_failed "It built but would not start. 'docker compose ps' shows what is running."
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
