#!/usr/bin/env bash
#
# Saves the app's container image, the one this server runs now, as one file
# that Docker on another machine can load. From the folder this repo is in:
#
#   ./deploy/export-image.sh
#
# The file is images/schema-studio-app-<commit>.tar.gz, named after the
# commit the image was built from, with a checksum file beside it. Hand over
# both. On the other machine:
#
#   sha256sum -c schema-studio-app-<commit>.tar.gz.sha256
#   docker load -i schema-studio-app-<commit>.tar.gz
#
# deploy/CONTAINER-IMAGE.md says what the image holds and how to start it
# there.
#
# Nothing secret is in the image: my-app/.dockerignore keeps .env out of every
# build, and the database lives in its own volume, not in the image. What does
# go in is the sign-in bypass setting, baked in when the image is built. So
# this refuses an image built with the bypass on, which lets anybody in as an
# admin, and one built before images said whether it is on.

set -euo pipefail

# cron and sudo start with a short PATH. Make sure docker is found, /snap/bin
# included in case Docker came as a snap.
export PATH="/usr/local/bin:/usr/bin:/bin:/snap/bin:${PATH:-}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_DIR/images"
LOCK_DIR="$REPO_DIR/.deploy.lock"
NAME="schema-studio-app"
BYPASS_LABEL="org.schema-studio.sign-in-bypass"
cd "$REPO_DIR"

fail() {
  echo "$*" >&2
  exit 1
}

# After step 4 of deploy/HARDENING.md the folder belongs to the app's own
# account, and only that account may take the lock and write the file.
[ -w "$REPO_DIR" ] || fail "This account may not write in $REPO_DIR. Run it as the app's own account: sudo -u schemastudio ./deploy/export-image.sh"

# deploy/auto-update.sh holds this lock while it deploys or swaps images, and
# deploy/backup.sh while it saves a copy of the database. Holding it here means
# no deploy swaps the image halfway through the save. A lock left behind by a
# run that died is cleared once it is an hour old, as those two do.
if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
  rmdir "$LOCK_DIR" 2>/dev/null || true
fi
mkdir "$LOCK_DIR" 2>/dev/null || fail "A deploy or a backup is running. Try again in a few minutes."

# Whatever happens next, a half-written file and the extra image name go, and
# the lock is let go.
part=""
tag=""
cleanup() {
  if [ -n "$part" ]; then rm -f "$part" || true; fi
  if [ -n "$tag" ]; then docker image rm "$tag" > /dev/null 2>&1 || true; fi
  rmdir "$LOCK_DIR"
}
trap cleanup EXIT

container="$(docker compose ps -q app | sed -n 1p)"
[ -n "$container" ] || fail "The app is not running here, so there is no image to save. 'docker compose ps' shows what is running."
image="$(docker inspect -f '{{.Image}}' "$container")"

# my-app/Dockerfile labels each image with the bypass setting it was built
# with. Only "false" is handed over: compose builds with that unless .env says
# otherwise. Docker prints nothing, or "<no value>", for a label an image does
# not have.
bypass="$(docker image inspect -f "{{if .Config.Labels}}{{index .Config.Labels \"$BYPASS_LABEL\"}}{{end}}" "$image")"
case "$bypass" in
  false) ;;
  "" | "<no value>")
    fail "The running image was built before images said whether their sign-in bypass is on, so it cannot be checked. Wait for the server to deploy a newer commit by itself (the deploy log says when), then run this again." ;;
  *)
    fail "The running image was built with the sign-in bypass set to '$bypass'. Only an image built with it off is saved, because the bypass lets anybody in as an admin. Take the NEXT_PUBLIC_AUTH_BYPASS line out of .env, rebuild with 'docker compose up -d --build', then run this again." ;;
esac

health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
[ "$health" = healthy ] || fail "The app is '$health', not healthy, so its image is not saved. Wait a minute and try again. 'docker compose ps' shows how it is doing."

# The file is named after the commit this folder is at. Under the lock that is
# the commit the running image was built from, as long as nobody changed the
# files by hand.
changes="$(git status --porcelain --untracked-files=no)"
[ -z "$changes" ] || fail "Files in $REPO_DIR were changed by hand, so the image may not match any commit. 'git status' there lists them, and 'git checkout -- .' there undoes them."
commit="$(git rev-parse --short=12 HEAD)"
file="$OUT_DIR/$NAME-$commit.tar.gz"

# Nothing in the file is secret, so every account here may read it, for
# whoever copies it off the server.
umask 022
mkdir -p "$OUT_DIR"

echo "The app is healthy and its image has the sign-in bypass off."
echo "Saving the image, built from commit $commit. This takes a minute or two..."
# The name it gets here is the one it has after a load on the other machine.
tag="$NAME:$commit"
docker tag "$image" "$tag"
part="$file.part"
docker save "$tag" | gzip > "$part"
# Read the whole file back before it gets its real name, so a file that was
# cut short never looks finished.
gzip -t "$part"
mv -f "$part" "$file"
part=""
(cd "$OUT_DIR" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256")

echo "Saved $file ($(du -h "$file" | cut -f1))"
echo "and its checksum, $file.sha256."
echo "Hand over both files. deploy/CONTAINER-IMAGE.md says how to load and start it."
