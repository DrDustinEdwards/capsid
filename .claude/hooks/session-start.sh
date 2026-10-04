#!/bin/sh
# SessionStart hook: give a Claude Code cloud session the Node the repo needs, then
# install dependencies, so `npm ci`, `npm run check` and `npm test` work first try.
#
# WHY. The cloud container ships Node 22 and npm 10 (/opt/node22). package.json engines
# and .nvmrc need Node 24 and npm 11, and npm 10 reads this lockfile as out of sync, so
# `npm ci` refuses and `npm test` fails with module-not-found. The container offers no
# Node setting, so the repo installs the version in .nvmrc itself.
#
# Cloud only (CLAUDE_CODE_REMOTE), and a no-op when the right Node and node_modules are
# already there, so a local session pays one `node -v`. POSIX sh (conventions 4.2).
# Changes no tracked file: not package.json, the lockfile, or engines.
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

fail() {
  echo "SESSION START FAILED: $1" >&2
  echo "SESSION START FAILED: $1"
  exit 1
}

want=$(tr -d 'v \n' < .nvmrc)
[ -n "$want" ] || fail ".nvmrc is empty"

# Right Node: same major as .nvmrc and not older than it.
node_ok() {
  have=$(node -v 2>/dev/null | tr -d 'v\n') || return 1
  [ -n "$have" ] || return 1
  [ "${have%%.*}" = "${want%%.*}" ] || return 1
  [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n 1)" = "$want" ]
}

if ! node_ok; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "no Node build for $(uname -m)" ;;
  esac
  name="node-v$want-linux-$arch"
  cache="${HOME}/.cache/capsid-node"
  if [ ! -x "$cache/$name/bin/node" ]; then
    mkdir -p "$cache"
    tmp=$(mktemp -d)
    base="https://nodejs.org/dist/v$want"
    curl -fsSL --retry 3 -o "$tmp/$name.tar.xz" "$base/$name.tar.xz" || fail "could not download $base/$name.tar.xz"
    curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" || fail "could not download $base/SHASUMS256.txt"
    (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -) || fail "checksum mismatch for $name.tar.xz"
    tar -xJf "$tmp/$name.tar.xz" -C "$cache" || fail "could not unpack $name.tar.xz"
    rm -r "$tmp"
  fi
  PATH="$cache/$name/bin:$PATH"
  export PATH
  node_ok || fail "installed Node $(node -v) does not satisfy .nvmrc $want"
  # Later commands in this session run with the same Node.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$cache/$name/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

# Install when node_modules is missing or older than the lockfile.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund || fail "npm ci failed under Node $(node -v), npm $(npm -v)"
fi

echo "Session ready: Node $(node -v), npm $(npm -v), dependencies installed."
