#!/bin/sh
# Mac / Linux: run your own copy of the tracker. See scripts/launch.cjs for what it does.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node isn't installed yet. Install the current LTS version from https://nodejs.org,"
  echo "then open a new terminal window and run ./start.sh again."
  echo ""
  exit 1
fi
exec node scripts/launch.cjs "$@"
