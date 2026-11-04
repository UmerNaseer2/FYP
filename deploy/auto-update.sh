#!/usr/bin/env bash
#
# Keeps the Schema Studio running on this server in step with GitHub.
#
# A timer runs this every five minutes (deploy/HARDENING.md sets it up; a cron
# line in deploy/README.md does the same). Most runs find nothing new and exit
# without a word. When `main` on GitHub has a commit this copy does not:
#
#   1. It checks the commit is signed with a key listed in
#      /etc/schema-studio/allowed_signers, and skips the commit if not. Someone
#      who gets push access to GitHub, with a stolen password or token, can
#      push code but cannot sign it, so it never reaches the server.
#   2. It waits until GitHub's CI has passed on that commit, and skips the
#      commit if CI failed. A push that breaks the build or the tests never
#      reaches the server.
#   3. It moves this copy to that commit. If someone edited files here by hand,
#      it stops and says so instead: the edit would be built into the app, and
#      the server would run code that is not on GitHub.
#   4. It rebuilds the app on the newest base image, so security fixes in it
#      arrive with each deploy, and swaps it in with docker compose. If the
#      build fails, the old app keeps running and the commit is tried again on
#      the next run, three tries in all. The database keeps its data throughout.
#   5. It waits for the new app to report healthy, then deletes the old image
#      the rebuild left behind, so the disk does not slowly fill up. If the new
#      app is not healthy within three minutes, it puts the old image back and
#      skips the commit until the next push, so the server is never left on a
#      broken version and does not rebuild it every five minutes.
#
# Each event is one timestamped line on stdout (the timer sends it to the
# system journal, cron to the log file). The full build output of the latest
# deploy is in deploy/last-build.log.
#
# Optional settings, put in front of the command in the crontab line, or as
# Environment= lines in the service file:
#   DEPLOY_BRANCH=main            the branch to follow
#   DEPLOY_SIGNERS_FILE=<path>    the list of trusted signing keys, if not in
#                                 /etc/schema-studio/allowed_signers
#   DEPLOY_UNSIGNED=1             deploy unsigned commits too (not recommended)
#   DEPLOY_SKIP_CI=1              deploy without waiting for CI (not recommended)

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

# A commit already skipped (CI failed on it, it failed to deploy three times,
# or it never got healthy) stays skipped until a newer push, so don't ask GitHub about it again
# every five minutes. The skip is kept in a file of its own because
# .deploy-state changes with every new message: a network outage would wipe
# it, and the commit would be built all over again.
if grep -q "^Skipping $short" "$SKIP_FILE" 2>/dev/null; then
  if [ -t 1 ]; then cat "$SKIP_FILE"; fi
  exit 0
fi

# Only commits signed with a trusted key are deployed. The list of keys sits
# outside this folder and belongs to root, so nothing pushed to GitHub can
# change it. Signing a commit approves it and everything before it.
SIGNERS_FILE="${DEPLOY_SIGNERS_FILE:-/etc/schema-studio/allowed_signers}"
if [ "${DEPLOY_UNSIGNED:-}" != "1" ]; then
  if [ ! -s "$SIGNERS_FILE" ]; then
    log_once "Not deploying $short: there is no list of trusted signing keys at $SIGNERS_FILE. Step 3 of deploy/HARDENING.md makes it."
    exit 1
  fi
  # git asks ssh-keygen to check the signature.
  if ! command -v ssh-keygen > /dev/null; then
    log_once "Not deploying $short: ssh-keygen is missing, and git needs it to check signatures. It comes with the openssh-client package."
    exit 1
  fi
  if ! git -c gpg.ssh.allowedSignersFile="$SIGNERS_FILE" verify-commit "$remote_sha" > /dev/null 2>&1; then
    skip "it is not signed with a key listed in $SIGNERS_FILE. Sign your commits and push again (deploy/HARDENING.md, step 3)."
    exit 0
  fi
fi

# A hand edit here would be built into the app, so the server would run code
# that is not on GitHub. Stop and say so instead. Only files git tracks count:
# .env and the files this script writes are not tracked.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log_once "Not deploying $short: files in $REPO_DIR were changed by hand. 'git status' there lists them, and 'git checkout -- .' there undoes them. The next run then carries on."
  exit 1
fi

# Prints success, pending or failed for commit $1, going by the run of the CI
# workflow (.github/workflows/ci.yml) that a push to $BRANCH started on it.
# Other workflows are left out: the desktop workflow builds installers the
# server never runs, so it must neither hold a deploy back nor stop one. Runs
# on other branches and on pull requests are left out too: the same commit is
# often pushed to several branches, and a run cancelled on one of those must
# not block the deploy here. Anything unexpected (no network, GitHub's hourly
# limit for anonymous callers) prints unknown, and the next run just asks
# again. The repo is public, so no token is needed and none is stored on the
# server.
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
# Only the CI workflow decides. The desktop workflow builds the installers,
# which the server does not run, and takes far longer.
runs = [r for r in runs if r.get("name") == "CI"]
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

# The Dockerfile's healthcheck loads /login every 30 seconds. This gives the
# app up to three minutes to say healthy, and prints what it said last.
wait_for_health() {
  local id state=starting
  id="$(docker compose ps -q app 2>/dev/null || true)"
  for _ in $(seq 1 36); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
    if [ "$state" = healthy ]; then break; fi
    sleep 5
  done
  echo "$state"
}

# Remember the image the app runs on now, so it can be put back if the new
# version will not start or never gets healthy. The rebuild takes its name
# away but does not delete it: only the prune at the very end does that, after
# a healthy deploy. On the first deploy no app is running, so there is none.
old_image=""
app_image=""
old_app_id="$(docker compose ps -q app 2>/dev/null || true)"
if [ -n "$old_app_id" ]; then
  old_image="$(docker inspect -f '{{.Image}}' "$old_app_id" 2>/dev/null || true)"
  app_image="$(docker inspect -f '{{.Config.Image}}' "$old_app_id" 2>/dev/null || true)"
fi

# Gives the remembered image its name back and starts the app on it again,
# without building anything. Logs how that went.
restore_previous() {
  if [ -z "$old_image" ] || [ -z "$app_image" ]; then
    log "No earlier version of the app was running, so there is none to put back."
    return
  fi
  if docker tag "$old_image" "$app_image" >> "$BUILD_LOG" 2>&1 \
    && docker compose up -d --no-build --force-recreate app >> "$BUILD_LOG" 2>&1; then
    log "Put the previous version (${local_sha:0:7}) back. The app is '$(wait_for_health)'."
  else
    log "Could not put the previous version (${local_sha:0:7}) back. 'docker compose ps' shows what is running."
  fi
}

# Build first, then swap. A failed build never touches the running app.
# --pull fetches the newest node base image, so its security fixes reach the
# server with the next deploy. If Docker Hub cannot be reached, build on the
# copy already here rather than fail.
if ! { docker compose build --pull > "$BUILD_LOG" 2>&1 \
  || docker compose build >> "$BUILD_LOG" 2>&1; }; then
  deploy_failed "The build failed, so the previous version is still running."
fi
# The same for the database: a newer postgres 17 image has its security fixes.
# Minor versions keep the data format, so the volume works with it as is.
docker compose pull --quiet db >> "$BUILD_LOG" 2>&1 || true
# compose replaces the app container with the new build. It recreates the
# database container only if its image or its settings in docker-compose.yml
# changed, and the data lives in a volume, so it is kept either way.
if ! docker compose up -d >> "$BUILD_LOG" 2>&1; then
  restore_previous
  deploy_failed "It built but would not start."
fi

# A new version that starts but never gets healthy is not marked deployed.
# Its log goes into deploy/last-build.log, the previous version is put back,
# and the commit is skipped at once: it started, so the build is fine and the
# fault is almost always in the code, and trying again would only take the
# app down for another three minutes. The next push is tried as usual.
health="$(wait_for_health)"
if [ "$health" != healthy ]; then
  log "$short started, but the app is '$health' after 3 minutes, so it is not kept."
  docker compose logs --no-color --tail 300 app >> "$BUILD_LOG" 2>&1 || true
  git reset --quiet --keep "$local_sha"
  restore_previous
  skip "the app was '$health' 3 minutes after it started. Its log is at the end of deploy/last-build.log."
  exit 1
fi
log "Deployed $short. The app is up and healthy."
echo "Deployed $short" > "$STATE_FILE"

# Each rebuild leaves the previous app image behind with no name. Remove those,
# and build cache older than three days, so the disk stays flat.
docker image prune -f > /dev/null 2>&1 || true
docker builder prune -f --filter until=72h > /dev/null 2>&1 || true
