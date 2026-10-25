#!/usr/bin/env bash
#
# Adds Schema Studio's apt source to a .deb that electron-builder made, so
# that a computer which installs the package then gets each new version
# through apt, with the rest of its updates.
#
# It adds two plain files to the package:
#
#   /etc/apt/sources.list.d/schema-studio.sources
#       where apt looks for new versions, and which key must have signed
#       them.
#   /usr/share/keyrings/schema-studio-archive-keyring.gpg
#       that key. The source names it in Signed-By, so apt trusts it for
#       this source alone and never for Ubuntu's own packages.
#
# They are plain files rather than configuration files, so each new version
# replaces them, and removing the package removes them too.
#
# It works on the finished .deb, after electron-builder, for two reasons.
# Only the copies that are published get an apt source, so the .deb files a
# desktop workflow run keeps for testing never update themselves. And
# electron-builder's own install and removal scripts, which set up the
# window's sandbox and its AppArmor profile, stay exactly as they are; a
# custom install script would replace them. Before it finishes, it checks
# that nothing else in the package changed.
#
# Usage:
#   add-apt-source.sh <package.deb> <source-address> <keyring.gpg> <out.deb> [version]
#
#   source-address  the folder apt reads, ending in a slash. Published copies
#                   use https://github.com/<owner>/<repo>/releases/latest/download/
#                   and the desktop workflow's update test uses a file:/ one.
#   keyring.gpg     the public key, as gpg --export writes it (binary, not
#                   armored).
#   version         a new version number for the package. Only the update
#                   test uses it, to make a newer copy of the same build.
#
# Needs dpkg-deb, so it runs on Ubuntu or Debian. Tested by the desktop
# workflow (.github/workflows/desktop.yml).

set -euo pipefail
# The same sorting and messages whatever the computer's language.
export LC_ALL=C
# New files get mode 0644 and new folders 0755.
umask 022

fail() {
  echo "add-apt-source.sh: $*" >&2
  exit 1
}

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "Usage: add-apt-source.sh <package.deb> <source-address> <keyring.gpg> <out.deb> [version]" >&2
  exit 2
fi
deb="$1"
address="$2"
keyring="$3"
out="$4"
version="${5:-}"

command -v dpkg-deb >/dev/null || fail "dpkg-deb is missing. Run this on Ubuntu or Debian."
[ -f "$deb" ] || fail "There is no package at $deb."
[ -d "$(dirname "$out")" ] || fail "The folder for $out does not exist."
# The address goes into the source file as it is, so it may hold only the
# characters a web or file address uses, and no spaces.
url_pattern='^(https://|file:/)[A-Za-z0-9._~/%:+-]+/$'
[[ $address =~ $url_pattern ]] || fail "The source address must start with https:// or file:/ and end with a slash."
[ -s "$keyring" ] || fail "There is no key at $keyring."
# apt reads a keyring named .gpg only in gpg's binary form.
if grep -q -e '-----BEGIN PGP' "$keyring"; then
  fail "$keyring is armored. Give it the binary key that gpg --export writes."
fi
# The version goes into the control file as it is, so it may hold only the
# digits, letters and . + ~ that plain versions use.
version_pattern='^[0-9][A-Za-z0-9.+~]*$'
if [ -n "$version" ] && ! [[ $version =~ $version_pattern ]]; then
  fail "$version is not a plain version number like 2.0.0 or 2.0.0+test."
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The package's files go to pkg/, and its control files (its description
# and its install and removal scripts) to pkg/DEBIAN/.
dpkg-deb -R "$deb" "$work/pkg"
# dpkg-deb -b wants the control folder at 0755, whatever the original had.
chmod 0755 "$work/pkg/DEBIAN"

install -d -m 0755 "$work/pkg/etc/apt/sources.list.d" "$work/pkg/usr/share/keyrings"
cat > "$work/pkg/etc/apt/sources.list.d/schema-studio.sources" <<EOF
# Schema Studio's updates. The schema-studio package put this file here, and
# each new version of it replaces the file, so changes to it do not last.
Types: deb
URIs: $address
Suites: ./
Signed-By: /usr/share/keyrings/schema-studio-archive-keyring.gpg
EOF
chmod 0644 "$work/pkg/etc/apt/sources.list.d/schema-studio.sources"
install -m 0644 "$keyring" "$work/pkg/usr/share/keyrings/schema-studio-archive-keyring.gpg"

# dpkg --verify checks installed files against md5sums, so the two new
# files go in it too.
if [ -f "$work/pkg/DEBIAN/md5sums" ]; then
  (cd "$work/pkg" && md5sum etc/apt/sources.list.d/schema-studio.sources usr/share/keyrings/schema-studio-archive-keyring.gpg) >> "$work/pkg/DEBIAN/md5sums"
fi

if [ -n "$version" ]; then
  [ "$(grep -c '^Version: ' "$work/pkg/DEBIAN/control")" = 1 ] || fail "The package's control file does not have exactly one Version line."
  sed -i "s/^Version: .*/Version: $version/" "$work/pkg/DEBIAN/control"
fi

dpkg-deb --root-owner-group -Zxz -b "$work/pkg" "$work/new.deb" >/dev/null

# Every file of the original package must still be there with the same
# mode, owner and size, and the only new entries may be the two files and
# their folders. tar lists each entry as mode, owner, size, date, time and
# name. The date and time can differ, so they are left out, and runs of
# spaces are squeezed because tar pads its columns.
listing() {
  dpkg-deb --fsys-tarfile "$1" | tar --numeric-owner -tvf - | sed -E 's/ +/ /g; s/^([^ ]+ [^ ]+ [^ ]+) [^ ]+ [^ ]+ /\1 /' | sort
}
listing "$deb" > "$work/old.txt"
listing "$work/new.deb" > "$work/new.txt"
if [ -n "$(comm -23 "$work/old.txt" "$work/new.txt")" ]; then
  comm -23 "$work/old.txt" "$work/new.txt" >&2
  fail "The new package changed or lost some of the original's files (above)."
fi
added=0
while IFS= read -r line; do
  case "$line" in
    "drwxr-xr-x 0/0 0 ./etc/" | "drwxr-xr-x 0/0 0 ./etc/apt/" | "drwxr-xr-x 0/0 0 ./etc/apt/sources.list.d/" | "drwxr-xr-x 0/0 0 ./usr/share/keyrings/") ;;
    "-rw-r--r-- 0/0 "*" ./etc/apt/sources.list.d/schema-studio.sources" | "-rw-r--r-- 0/0 "*" ./usr/share/keyrings/schema-studio-archive-keyring.gpg")
      added=$((added + 1))
      ;;
    *) fail "The new package has an entry it should not have: $line" ;;
  esac
done < <(comm -13 "$work/old.txt" "$work/new.txt")
[ "$added" = 2 ] || fail "The new package is missing the apt source or its key."

# The install and removal scripts must be the very same, and so must the
# control file, apart from its Version line when a new version was given.
dpkg-deb -e "$deb" "$work/old-control"
dpkg-deb -e "$work/new.deb" "$work/new-control"
if ! diff -rq -x md5sums -x control "$work/old-control" "$work/new-control" >&2; then
  fail "The new package changed its install or removal scripts."
fi
if ! diff <(grep -v '^Version: ' "$work/old-control/control") <(grep -v '^Version: ' "$work/new-control/control") >&2; then
  fail "The new package changed its control file."
fi
wanted="${version:-$(dpkg-deb -f "$deb" Version)}"
[ "$(dpkg-deb -f "$work/new.deb" Version)" = "$wanted" ] || fail "The new package does not have version $wanted."

mv "$work/new.deb" "$out"
echo "Added the apt source to $out."
