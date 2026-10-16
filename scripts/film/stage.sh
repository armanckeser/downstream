#!/bin/sh
# Sets up everything the README film shows, with nothing real in it: the
# fictional storefront repository, a review of its pull request with no
# walkthrough yet, and a Downstream server whose gh is the made-up inbox.
# sh scripts/film/stage.sh <dir> <port>         set up, start the server, print home=<url>
# sh scripts/film/stage.sh <dir> <port> review  open the review on top, print review=<url>
# Stop it with DOWNSTREAM_HOME=<dir>/home downstream stop.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
dir=${1:-/tmp/downstream-film}
port=${2:-4417}

export DOWNSTREAM_HOME="$dir/home" DOWNSTREAM_HOSTED=1 DOWNSTREAM_FILM_REPO="$dir/storefront" PATH="$here/bin:$PATH"
ds() { node "$root/bin/downstream.mjs" "$@"; }

if [ "${3:-}" = review ]; then
  cd "$dir/storefront"
  ds open --pr 482 --port "$port" >/dev/null
  echo "review=$(ds url)"
  exit 0
fi

ds stop >/dev/null 2>&1 || true
rm -rf "$dir"
node "$here/storefront.mjs" "$dir/storefront" >/dev/null
cd "$dir/storefront"
ds home --port "$port" >/dev/null
# The server takes the next free port when this one is busy; print the one it got.
echo "home=$(node -p "require('$DOWNSTREAM_HOME/server.json').url")/"
