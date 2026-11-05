#!/usr/bin/env bash
#
# Saves a copy of Schema Studio's own database: the saved connections, the
# organizations and their people, the scripts and the history. The databases
# the app compares are not in it; they stay wherever they are.
#
# A timer runs this every night at 02:30 (deploy/HARDENING.md, step 4 sets it
# up; a cron line in deploy/README.md, step 8, does the same). By hand, from
# the folder this repo is in:
#
#   ./deploy/backup.sh
#
# Each copy is one file in backups/, such as
# backups/schema-studio-2026-11-05-0230.dump. The newest 14 are kept. Older
# ones are deleted only after a new copy has been saved and read back, so a
# failed backup never costs a good one.
#
# A copy is as secret as .env. The connection passwords and GitHub access
# tokens in it are encrypted with APP_ENCRYPTION_KEY from .env, and only that
# key opens them again. Keep the key, and keep it apart from the copies.
#
# To list what is in a copy:
#
#   docker compose exec -T db pg_restore --list < backups/<file>.dump | head
#
# To put a copy back, replacing everything the database holds now. Run
# ./deploy/backup.sh first, so what is there now is saved too. The app is
# stopped meanwhile, so nothing writes to the database halfway through, and
# the copy goes in whole or not at all:
#
#   docker compose stop app
#   docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < backups/<file>.dump
#   docker compose start app
#
# Optional settings, put in front of the command in the crontab line, or as
# Environment= lines in the service file:
#   BACKUP_KEEP=14    how many copies to keep

set -euo pipefail

# cron starts with an almost empty PATH. Make sure docker is found, /snap/bin
# included in case Docker came as a snap.
export PATH="/usr/local/bin:/usr/bin:/bin:/snap/bin:${PATH:-}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$REPO_DIR/backups"
LOCK_DIR="$REPO_DIR/.deploy.lock"
KEEP="${BACKUP_KEEP:-14}"
# Anything that is not a whole number of at least 1 keeps the default.
[ "$KEEP" -ge 1 ] 2>/dev/null || KEEP=14
cd "$REPO_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }

# Only this account can read the copies.
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# deploy/auto-update.sh holds this lock while it deploys or swaps images.
# Wait for it, up to half an hour, rather than copy a database that is being
# restarted. A lock left behind by a run that died is cleared once it is an
# hour old, as auto-update.sh does.
got_lock=""
for try in $(seq 1 60); do
  if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    got_lock=1
    break
  fi
  if [ "$try" = 1 ] && [ -t 1 ]; then echo "A deploy is running. Waiting for it to finish..."; fi
  sleep 30
done
if [ -z "$got_lock" ]; then
  log "Backup skipped: a deploy has held the lock for over half an hour. The next backup is tomorrow night, or run this again later."
  exit 1
fi
trap 'rmdir "$LOCK_DIR"' EXIT

if [ -z "$(docker compose ps -q --status running db 2>/dev/null || true)" ]; then
  log "Backup skipped: the database container is not running. 'docker compose ps' shows what is."
  exit 1
fi

name="schema-studio-$(date +%Y-%m-%d-%H%M).dump"
file="$BACKUP_DIR/$name"

# A copy half written by a run that died is of no use.
rm -f "$BACKUP_DIR"/*.partial

# pg_dump runs inside the database container, so its version always matches
# the database's, and it connects over the container's own socket, so it
# needs no password. The custom format is compressed and is what pg_restore
# reads.
if ! docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file.partial"; then
  rm -f "$file.partial"
  log "Backup failed: pg_dump stopped with the error above. The earlier copies are untouched."
  exit 1
fi
# Read it back before trusting it: pg_restore reads the whole copy, as a
# restore would, writes what it would run to /dev/null, and fails on a copy
# that is cut short or broken.
if [ ! -s "$file.partial" ] || ! docker compose exec -T db pg_restore -f /dev/null < "$file.partial"; then
  rm -f "$file.partial"
  log "Backup failed: the new copy could not be read back. The earlier copies are untouched."
  exit 1
fi
mv "$file.partial" "$file"

# Keep the newest copies, delete the rest.
ls -1t "$BACKUP_DIR"/schema-studio-*.dump | tail -n +$(( KEEP + 1 )) | while read -r old; do
  rm -f "$old"
done

log "Saved backups/$name ($(du -h "$file" | cut -f1)). Keeping the newest $KEEP."
