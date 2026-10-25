#!/usr/bin/env bash
#
# Turns a folder of Schema Studio .deb files into the signed apt repository
# that installed copies update from. It is a flat repository: one folder
# that holds the .deb files and the index files apt reads, which suits a
# GitHub release.
#
# The .deb files should already have the apt source in them
# (add-apt-source.sh). This writes, next to them:
#
#   Packages      every package, with its version, size and hashes.
#   Packages.gz   the same list, compressed, for a smaller download.
#   Release       the hashes of the two lists.
#   InRelease     Release with the signature inside it. apt reads this one
#                 first.
#   Release.gpg   the same signature on its own, for tools that read Release
#                 and its signature separately.
#
# apt trusts an update through a chain: the key named in the package's
# source checks the signature on InRelease, InRelease holds the hash of
# Packages, and Packages holds the hash of each .deb. A change to any file
# along the way stops the update.
#
# Usage:
#   make-apt-repo.sh <folder> <key-fingerprint>
#
#   key-fingerprint  the signing key's full fingerprint. The key must be in
#                    gpg's keyring (the GNUPGHOME folder), with no
#                    passphrase, since nobody is there to type one.
#
# Needs apt-ftparchive (from apt-utils) and gpg. Tested by the desktop
# workflow (.github/workflows/desktop.yml).

set -euo pipefail
# The same sorting and messages whatever the computer's language.
export LC_ALL=C
# New files get mode 0644.
umask 022

fail() {
  echo "make-apt-repo.sh: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "Usage: make-apt-repo.sh <folder> <key-fingerprint>" >&2
  exit 2
fi
folder="$1"
key="$2"

command -v apt-ftparchive >/dev/null || fail "apt-ftparchive is missing. Install apt-utils."
for tool in gpg gpgv gzip; do
  command -v "$tool" >/dev/null || fail "$tool is missing."
done
[ -d "$folder" ] || fail "There is no folder at $folder."
fingerprint_pattern='^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$'
[[ $key =~ $fingerprint_pattern ]] || fail "Give the key's full fingerprint, not its name or a short ID."
gpg --batch --list-secret-keys "$key" >/dev/null 2>&1 || fail "The key is not in the gpg keyring (GNUPGHOME)."

cd "$folder" || fail "Could not open $folder."
shopt -s nullglob
debs=(*.deb)
[ "${#debs[@]}" -gt 0 ] || fail "There are no .deb files in $folder."

# apt-ftparchive would list an old Release or Packages file in the new
# Release, so the old index files go first.
rm -f Packages Packages.gz Release InRelease Release.gpg

# Each package's Filename reads ./<file>.deb, which apt adds to the
# source's address.
apt-ftparchive packages . > Packages
gzip -9n < Packages > Packages.gz

# Release is written somewhere else first: apt-ftparchive hashes every file
# named Release it finds, and the one being written would be among them.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Origin and Label must never change, because apt stops updating from a
# source whose Origin or Label changed until someone accepts that by hand.
# A flat repository needs no Suite or Codename. There is no Valid-Until
# either, since one release can stay the latest for months.
apt-ftparchive -o APT::FTPArchive::Release::Origin="Schema Studio" -o APT::FTPArchive::Release::Label="Schema Studio" release . > "$tmp/Release"
mv "$tmp/Release" Release

gpg --batch --yes --local-user "$key" --digest-algo SHA512 --clearsign --output InRelease Release ||
  fail "gpg could not sign with the key. It must have no passphrase, since nobody is there to type one."
gpg --batch --yes --local-user "$key" --digest-algo SHA512 --armor --detach-sign --output Release.gpg Release ||
  fail "gpg could not sign with the key. It must have no passphrase, since nobody is there to type one."

# Both signatures are checked the way apt checks them, with the public key
# alone, so a broken signature is never published.
gpg --batch --export "$key" > "$tmp/key.gpg"
if ! check="$(gpgv --keyring "$tmp/key.gpg" InRelease 2>&1 && gpgv --keyring "$tmp/key.gpg" Release.gpg Release 2>&1)"; then
  echo "$check" >&2
  fail "The new signatures do not check out with the key's public half."
fi

echo "Made an apt repository in $folder:"
ls -l -- Packages Packages.gz Release InRelease Release.gpg "${debs[@]}"
