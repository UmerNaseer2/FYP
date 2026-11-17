#!/usr/bin/env bash
# Schema Studio setup in one command: SETUP-GUIDE.md steps 2 to 5 and 7, plus
# the three values from step 6.
#
#   bash ~/schema-studio-download/kit/setup.sh
#
# Run it as yourself, not with sudo, after step 1 (Docker Engine and
# PostgreSQL 16 installed). Do step 6 (the Microsoft app registration) first
# and it finishes in one go. In order, it:
#
#   * starts PostgreSQL and Docker if they are stopped;
#   * checks the image file against its .sha256 and loads it into Docker;
#   * makes /opt/schema-studio, which only you can open, and copies the kit
#     into it;
#   * makes .env from example.env, which only you can read;
#   * makes the app's login and database with a random password (sql/01, run
#     as the postgres user) and puts the address in .env;
#   * loads the tables as the app's login (sql/02);
#   * puts two random keys in .env (NEXTAUTH_SECRET, APP_ENCRYPTION_KEY);
#   * asks for the three Microsoft values and puts them in .env;
#   * starts the app and waits until it answers.
#
# Running it again is safe. It keeps what is done already, above all the
# password and the keys in .env, and does only what is missing. So it is also
# how to finish after skipping the Microsoft questions, how to start
# everything after Windows restarts, and, run from a newer download, how to
# install a new version.
#
# It never prints a password, a key or the client secret. It uses sudo to make
# the folder, to start PostgreSQL and Docker, and to run SQL as the postgres
# user.
#
# Without questions (in a script or CI), the Microsoft values can come from
# the environment: AZURE_AD_CLIENT_ID, AZURE_AD_TENANT_ID and
# AZURE_AD_CLIENT_SECRET. For an app database that is not on this machine
# (your own Supabase), give its address as DATABASE_URL_A in the environment
# (or in /opt/schema-studio/.env) the first time; the script then leaves
# PostgreSQL on this machine alone (SETUP-GUIDE.md, "Using your own Supabase
# instead").

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this with bash: bash $0" >&2
  exit 1
fi
set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '2,/^$/s/^# \{0,1\}//p' "$0"
    exit 0
    ;;
esac

INSTALL_DIR=/opt/schema-studio
ENV_FILE="$INSTALL_DIR/.env"
IMAGE=schema-studio-app:handover
GUIDE=SETUP-GUIDE.md

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DOWNLOAD_DIR="$(dirname "$KIT_DIR")"
FROM_INSTALL=no
if [ -d "$INSTALL_DIR" ] && [ "$KIT_DIR" = "$(cd "$INSTALL_DIR" 2> /dev/null && pwd -P)" ]; then
  FROM_INSTALL=yes
fi

say() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() {
  printf '\nStopped: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '   %s\n' "$line" >&2; done
  exit 1
}
need() {
  command -v "$1" > /dev/null 2>&1 || fail "$1 is not installed." "$2"
}

# The value of one setting in .env, without quotes around it, or nothing.
get_env() {
  [ -f "$ENV_FILE" ] || return 0
  K="$1" awk -v q="'" '
    index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2) }
    END {
      sub(/[ \t\r]+$/, "", v)
      n = length(v)
      f = substr(v, 1, 1)
      if (n >= 2 && f == substr(v, n, 1) && (f == q || f == "\"")) v = substr(v, 2, n - 2)
      printf "%s", v
    }' "$ENV_FILE"
}

# Set one setting in .env, in place of its line (or as a new line at the end).
# The new file is made beside the old one, readable by you only, then moved
# over it. A value with anything but plain characters goes in single quotes,
# which Compose reads exactly as written ($ included).
PLAIN='^[A-Za-z0-9_.~:/@%+=?&-]*$'
set_env() {
  local value="$2" tmp
  if ! [[ $value =~ $PLAIN ]]; then
    value="'$value'"
  fi
  tmp="$(mktemp "$INSTALL_DIR/.env.XXXXXX")"
  K="$1" V="$value" awk '
    index($0, ENVIRON["K"] "=") == 1 {
      if (!written) print ENVIRON["K"] "=" ENVIRON["V"]
      written = 1
      next
    }
    { print }
    END { if (!written) print ENVIRON["K"] "=" ENVIRON["V"] }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# The host and the port of a postgres:// address. The host keeps the brackets
# of an IPv6 address.
url_authority() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  printf '%s' "${rest##*@}"
}
url_host() {
  local a
  a="$(url_authority "$1")"
  case "$a" in
    \[*) printf '%s]' "${a%%]*}" ;;
    *) printf '%s' "${a%%:*}" ;;
  esac
}
url_port() {
  local a
  a="$(url_authority "$1")"
  a="${a##*]}"
  case "$a" in
    *:*) printf '%s' "${a##*:}" ;;
    *) printf 5432 ;;
  esac
}

# ---------------------------------------------------------------- before anything

[ "$(uname -s)" = Linux ] ||
  fail "This script is for Ubuntu (Ubuntu on WSL counts)." "Elsewhere, follow $GUIDE steps 2 to 7 by hand."
[ "$(id -u)" -ne 0 ] ||
  fail "Run it as yourself, not as root or with sudo." "It asks for sudo itself where it needs it."
if [ ! -f "$KIT_DIR/docker-compose.yml" ] || [ ! -f "$KIT_DIR/example.env" ] || [ ! -d "$KIT_DIR/sql" ]; then
  fail "$KIT_DIR is not the kit folder." "Run the setup.sh inside the unzipped download: bash ~/schema-studio-download/kit/setup.sh"
fi

need sudo "sudo apt install -y sudo"
need openssl "sudo apt install -y openssl"
need sha256sum "sudo apt install -y coreutils"
need docker "Install Docker Engine first: $GUIDE, step 1."

say "sudo"
info "Some steps need sudo. Type your Ubuntu password if it asks."
sudo -v || fail "sudo did not work." "This script needs an account that can use sudo."

# ------------------------------------------------------------------------- Docker

say "Docker ($GUIDE, step 1)"
DOCKER=(docker)
find_docker() {
  if docker info > /dev/null 2>&1; then
    DOCKER=(docker)
  elif sudo docker info > /dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    return 1
  fi
}
if ! find_docker; then
  info "Docker is not running. Starting it."
  sudo service docker start > /dev/null 2>&1 || true
  for _ in $(seq 30); do
    if find_docker; then break; fi
    sleep 1
  done
  find_docker || fail "Docker does not answer." "Look at: sudo service docker status" "$GUIDE, step 1."
fi
docker_os="$("${DOCKER[@]}" info --format '{{.OperatingSystem}}')"
case "$docker_os" in
  *"Docker Desktop"*)
    fail "This is Docker Desktop, and the kit is made for Docker Engine." \
      "$GUIDE, \"Docker Desktop instead of Docker Engine\", says what to do."
    ;;
esac
"${DOCKER[@]}" compose version > /dev/null 2>&1 ||
  fail "The Docker Compose plugin is missing." "sudo apt install -y docker-compose-plugin"
info "Docker $("${DOCKER[@]}" version --format '{{.Server.Version}}'), Compose $("${DOCKER[@]}" compose version --short) on $docker_os."
if [ "${DOCKER[0]}" = sudo ]; then
  info "docker needs sudo for you, so this script uses sudo docker."
fi

# --------------------------------------------------------------------- PostgreSQL

# Where the app's database is to be: made here (no address in .env yet), on
# this machine already (an address at 127.0.0.1 or localhost), or elsewhere,
# such as Supabase (any other address), which the script leaves alone.
DB_URL="$(get_env DATABASE_URL_A)"
DB_URL_FROM_ENV=no
if [ -z "$DB_URL" ] && [ -n "${DATABASE_URL_A:-}" ]; then
  DB_URL="$DATABASE_URL_A"
  DB_URL_FROM_ENV=yes
  case "$DB_URL" in
    postgres://*@* | postgresql://*@*) ;;
    *) fail "DATABASE_URL_A from the environment is not a postgres:// address with a login in it." ;;
  esac
  case "$DB_URL" in
    *"'"* | *[[:space:]]*)
      fail "DATABASE_URL_A from the environment has a quote or a space in it." \
        "In the password, write ' as %27 and a space as %20."
      ;;
  esac
fi
if [ -z "$DB_URL" ]; then
  DB_MODE=new
else
  case "$(url_host "$DB_URL")" in
    127.0.0.1 | localhost | "[::1]") DB_MODE=local ;;
    *) DB_MODE=remote ;;
  esac
fi

say "PostgreSQL ($GUIDE, step 1)"
if [ "$DB_MODE" = remote ]; then
  info "DATABASE_URL_A points at $(url_host "$DB_URL"), not this machine: leaving PostgreSQL here alone."
else
  need pg_lsclusters "Install PostgreSQL 16 first: $GUIDE, step 1."
  need psql "Install PostgreSQL 16 first: $GUIDE, step 1."
  need pg_isready "Install PostgreSQL 16 first: $GUIDE, step 1."
  clusters="$(pg_lsclusters -h 2> /dev/null || true)"
  if [ "$DB_MODE" = new ]; then
    # The version 16 one, or else the newest at 15 or later.
    line="$(printf '%s\n' "$clusters" | awk '$1 == 16 && !found { print; found = 1 }')"
    if [ -z "$line" ]; then
      line="$(printf '%s\n' "$clusters" | awk '$1 + 0 >= 15' | sort -n -k1,1 | tail -n 1)"
    fi
    [ -n "$line" ] || fail "There is no PostgreSQL 16 on this machine." "Install it: $GUIDE, step 1."
  else
    want="$(url_port "$DB_URL")"
    line="$(printf '%s\n' "$clusters" | awk -v p="$want" '$3 == p && !found { print; found = 1 }')"
    [ -n "$line" ] ||
      fail "DATABASE_URL_A in .env uses port $want, and no PostgreSQL here has that port." "pg_lsclusters lists them."
  fi
  read -r PG_VER PG_NAME PG_PORT PG_STATUS _ <<< "$line"
  if [ "${PG_STATUS%%,*}" != online ]; then
    info "PostgreSQL $PG_VER is stopped. Starting it."
    sudo service postgresql start > /dev/null 2>&1 || true
    if ! pg_isready -q -p "$PG_PORT"; then
      sudo pg_ctlcluster "$PG_VER" "$PG_NAME" start > /dev/null 2>&1 || true
    fi
  fi
  for _ in $(seq 30); do
    if pg_isready -q -p "$PG_PORT"; then break; fi
    sleep 1
  done
  pg_isready -q -p "$PG_PORT" ||
    fail "PostgreSQL $PG_VER does not answer on port $PG_PORT." "Try: sudo service postgresql start" "Then look at: pg_lsclusters"
  info "PostgreSQL $PG_VER ($PG_NAME) is running on port $PG_PORT."
  if [ "$PG_VER" != 16 ]; then
    info "Note: the kit is made and tested for PostgreSQL 16."
  fi
fi

# SQL as the postgres superuser, from / so it does not warn that it cannot
# open the current folder.
pg_super() {
  (cd / && sudo -u postgres psql -X -q -p "$PG_PORT" -v ON_ERROR_STOP=1 "$@")
}
pg_super_with_password() {
  (cd / && sudo --preserve-env=SS_DB_PASSWORD -u postgres psql -X -q -p "$PG_PORT" -v ON_ERROR_STOP=1 "$@")
}

# -------------------------------------------------------------------------- image

say "The image ($GUIDE, step 2)"
shopt -s nullglob
image_files=("$DOWNLOAD_DIR"/schema-studio-app-*.tar.gz)
shopt -u nullglob
loaded="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$IMAGE" 2> /dev/null || true)"
if [ "${#image_files[@]}" -gt 1 ]; then
  fail "There is more than one image file in $DOWNLOAD_DIR." "Unzip each download into a new, empty folder."
elif [ "${#image_files[@]}" -eq 0 ]; then
  [ -n "$loaded" ] ||
    fail "No image file beside the kit folder, and no $IMAGE in Docker." \
      "Unzip the download and run the setup.sh inside it: $GUIDE, step 2."
  info "No image file here: using the $IMAGE already in Docker."
else
  image_file="${image_files[0]}"
  [ -f "$image_file.sha256" ] || fail "$image_file.sha256 is missing." "Unzip the whole download again."
  (cd "$DOWNLOAD_DIR" && sha256sum -c --quiet "$(basename "$image_file").sha256") ||
    fail "The image file is damaged: it does not match its checksum." "Download the zip again."
  info "Checksum OK."
  version="$(basename "$image_file" .tar.gz)"
  version="${version#schema-studio-app-}"
  this_version="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "schema-studio-app:$version" 2> /dev/null || true)"
  if [ -n "$this_version" ] && [ "$this_version" = "$loaded" ]; then
    info "Version $version is loaded already."
  else
    info "Loading version $version into Docker. This takes a minute."
    "${DOCKER[@]}" load -q -i "$image_file" > /dev/null
    loaded="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$IMAGE")"
    [ "$loaded" = "$("${DOCKER[@]}" image inspect -f '{{.Id}}' "schema-studio-app:$version")" ] ||
      fail "The image file did not give $IMAGE." "Download the zip again."
    info "Loaded. Docker now has it as $IMAGE and schema-studio-app:$version."
  fi
fi

# ------------------------------------------------------------------ folder, .env

say "The folder $INSTALL_DIR ($GUIDE, steps 2 and 5)"
me="$(id -un)"
if [ ! -d "$INSTALL_DIR" ]; then
  sudo install -d -m 700 -o "$me" -g "$(id -gn)" "$INSTALL_DIR"
  info "Made it."
fi
owner="$(stat -c %U "$INSTALL_DIR")"
[ "$owner" = "$me" ] ||
  fail "$INSTALL_DIR belongs to $owner, not to you ($me)." "Make it yours: sudo chown \"\$USER\": $INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
info "Only you can open it (mode 700)."
if [ "$FROM_INSTALL" = no ]; then
  cp -r "$KIT_DIR/." "$INSTALL_DIR/"
  info "Copied the kit into it."
fi
if [ ! -f "$ENV_FILE" ]; then
  (umask 077 && cp "$INSTALL_DIR/example.env" "$ENV_FILE")
  info "Made .env from example.env."
fi
chmod 600 "$ENV_FILE"
info "Only you can read .env (mode 600)."
if [ "$DB_URL_FROM_ENV" = yes ]; then
  set_env DATABASE_URL_A "$DB_URL"
  info "Put DATABASE_URL_A from the environment in .env."
fi

# ----------------------------------------------------------- database and login

if [ "$DB_MODE" = new ]; then
  say "The app's database and its login ($GUIDE, step 3)"
  has_role="$(pg_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'schema_studio'")"
  has_db="$(pg_super -tAc "SELECT 1 FROM pg_database WHERE datname = 'schema_studio'")"
  SS_DB_PASSWORD="$(openssl rand -hex 24)"
  export SS_DB_PASSWORD
  if [ -z "$has_role" ] && [ -z "$has_db" ]; then
    pg_super_with_password -f - < "$INSTALL_DIR/sql/01-database-and-login.sql" > /dev/null
    info "Made the login schema_studio and the database schema_studio (sql/01)."
  elif [ -n "$has_role" ] && [ -n "$has_db" ]; then
    printf '%s\n' '\getenv p SS_DB_PASSWORD' "ALTER ROLE schema_studio PASSWORD :'p';" |
      pg_super_with_password -f - > /dev/null
    info "The login and the database were there already, and .env had no address."
    info "Gave the login a new random password."
  else
    fail "Only half of an earlier database setup is there (the login or the database, not both)." \
      "To start over, which deletes the app's data:" \
      "sudo -u postgres psql -c 'DROP DATABASE IF EXISTS schema_studio' -c 'DROP ROLE IF EXISTS schema_studio'" \
      "Then run this again."
  fi
  if ! PGPASSWORD="$SS_DB_PASSWORD" psql -X -h 127.0.0.1 -p "$PG_PORT" -U schema_studio -d schema_studio \
    -tAc 'SELECT 1' > /dev/null; then
    fail "The login cannot sign in over 127.0.0.1 (PostgreSQL's answer is above)." \
      "$GUIDE, \"Common problems\". Running this again is safe."
  fi
  info "Checked: it signs in over 127.0.0.1, as the app will."
  set_env DATABASE_URL_A "postgres://schema_studio:${SS_DB_PASSWORD}@127.0.0.1:${PG_PORT}/schema_studio"
  unset SS_DB_PASSWORD
  info "Put its address, with the password, in .env as DATABASE_URL_A."
  DB_URL="$(get_env DATABASE_URL_A)"
fi

# --------------------------------------------------------------------- tables

if [ "$DB_MODE" != remote ]; then
  say "The tables ($GUIDE, step 4)"
  case "$DB_URL" in
    *@*/schema_studio | *@*/schema_studio\?*)
      count_sql="SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
      count="$(pg_super -d schema_studio -tAc "$count_sql")"
      if [ "$count" = 0 ]; then
        # As the app's login, so it owns every table, and in one transaction,
        # so an error leaves nothing half made.
        pg_super -d schema_studio -1 -c 'SET ROLE schema_studio' -f - \
          < "$INSTALL_DIR/sql/02-schema-studio-tables.sql" > /dev/null
        info "Loaded sql/02 as the login schema_studio: $(pg_super -d schema_studio -tAc "$count_sql") tables."
      else
        info "The database has $count tables already: leaving them as they are."
      fi
      others="$(pg_super -d schema_studio -tAc "$count_sql AND tableowner <> 'schema_studio'")"
      [ "$others" = 0 ] ||
        fail "$others of the app's tables are not owned by schema_studio." \
          "$GUIDE, \"Common problems\", \"permission denied for schema public\"."
      ;;
    *)
      info "DATABASE_URL_A names another database: the app makes its tables there itself."
      ;;
  esac
fi

# ----------------------------------------------------------------------- keys

say "Keys ($GUIDE, step 5)"
for key in NEXTAUTH_SECRET APP_ENCRYPTION_KEY; do
  if [ -n "$(get_env "$key")" ]; then
    info "$key is set already: kept."
  else
    set_env "$key" "$(openssl rand -hex 32)"
    info "$key: made a new random one."
  fi
done

# ------------------------------------------------------------ Microsoft sign-in

GUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
label_of() {
  case "$1" in
    AZURE_AD_CLIENT_ID) printf 'Application (client) ID' ;;
    AZURE_AD_TENANT_ID) printf 'Directory (tenant) ID' ;;
    AZURE_AD_CLIENT_SECRET) printf 'Client secret Value' ;;
  esac
}
# What is wrong with a value, or nothing.
problem_with() {
  case "$1" in
    AZURE_AD_CLIENT_ID | AZURE_AD_TENANT_ID)
      if ! [[ $2 =~ $GUID ]]; then
        printf 'an ID looks like 1b2c3d4e-0000-1111-2222-333344445555 (the Overview page has it)'
      fi
      ;;
    AZURE_AD_CLIENT_SECRET)
      if [[ $2 =~ $GUID ]]; then
        printf 'that is the Secret ID; the secret is in the Value column beside it'
      elif [ "${#2}" -lt 20 ]; then
        printf 'too short for a client secret Value'
      elif [[ $2 == *"'"* || $2 == *'"'* ]]; then
        printf 'a client secret has no quotes in it'
      fi
      ;;
  esac
}

say "Microsoft sign-in ($GUIDE, step 6)"
auth_url="$(get_env AUTH_URL)"
auth_url="${auth_url:-http://localhost:3000}"
declare -A new_value=()
missing=()
asked=no
skipping=no
for key in AZURE_AD_CLIENT_ID AZURE_AD_TENANT_ID AZURE_AD_CLIENT_SECRET; do
  label="$(label_of "$key")"
  if [ -n "$(get_env "$key")" ]; then
    info "$label is set already: kept."
    continue
  fi
  value="${!key:-}"
  if [ -n "$value" ]; then
    problem="$(problem_with "$key" "$value")"
    [ -z "$problem" ] || fail "$key from the environment is not right: $problem."
  elif [ -t 0 ] && [ "$skipping" = no ]; then
    if [ "$asked" = no ]; then
      asked=yes
      info "From your own app registration in Microsoft Entra ID. Its redirect URI,"
      info "under the platform Web, must be:"
      info "  $auth_url/api/auth/callback/microsoft-entra-id"
      info "Not registered yet? Press Enter to skip, do step 6, then run this again."
      echo
    fi
    while :; do
      if [ "$key" = AZURE_AD_CLIENT_SECRET ]; then
        read -r -s -p "   $label (hidden as you type or paste): " value || value=""
        echo
      else
        read -r -p "   $label: " value || value=""
      fi
      value="${value//[[:space:]]/}"
      if [ -z "$value" ]; then
        skipping=yes
        break
      fi
      problem="$(problem_with "$key" "$value")"
      [ -n "$problem" ] || break
      info "Not right: $problem. Try again, or press Enter to skip."
    done
  fi
  if [ -n "$value" ]; then
    new_value[$key]="$value"
  else
    missing+=("$label")
  fi
done
for key in AZURE_AD_CLIENT_ID AZURE_AD_TENANT_ID AZURE_AD_CLIENT_SECRET; do
  [ -n "${new_value[$key]:-}" ] || continue
  set_env "$key" "${new_value[$key]}"
  info "$(label_of "$key"): saved in .env."
done

if [ "${#missing[@]}" -gt 0 ]; then
  say "Not started yet"
  info "Everything else is ready. Still needed in .env:"
  for label in "${missing[@]}"; do info "  * $label"; done
  info "Do $GUIDE step 6, then run this again:"
  info "  bash $INSTALL_DIR/setup.sh"
  exit 0
fi

# ---------------------------------------------------------------------- start

say "Starting Schema Studio ($GUIDE, step 7)"
cd "$INSTALL_DIR"
if ! timeout 300 "${DOCKER[@]}" compose up -d --wait; then
  "${DOCKER[@]}" compose logs --no-color --tail 40 app >&2 || true
  fail "The app did not come up. Its last lines are above." "$GUIDE, \"Common problems\", explains the usual causes."
fi

say "Schema Studio is running"
info "Open $auth_url in a browser on this machine (on WSL, a Windows one works)."
info "The first person from your Microsoft directory to sign in becomes its Admin,"
info "so sign in first yourself. Then carry on with $GUIDE, steps 8 to 10."
echo
info "Keep a copy of $ENV_FILE in your password manager, above all the"
info "APP_ENCRYPTION_KEY line: without it, saved passwords cannot be read."
if [ "$FROM_INSTALL" = no ] && [ "$(basename "$DOWNLOAD_DIR")" = schema-studio-download ]; then
  info "The download is no longer needed: rm -r $DOWNLOAD_DIR ~/schema-studio-handover.zip"
fi
info "Run this again at any time, for example after Windows restarts:"
info "  bash $INSTALL_DIR/setup.sh"
