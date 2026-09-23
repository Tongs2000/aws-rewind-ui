#!/bin/sh
# Start the rewind web front end.
#
#   ./run.sh                      demo mode on http://127.0.0.1:8787
#   ./run.sh --mode live          the ambient AWS configuration, like the rewind command
#   ./run.sh --mode live --identity perf-agent --region us-west-1
#
# Prefers the CLI's virtualenv interpreter, because live mode needs the boto3 that is
# installed there. Demo mode runs on a bare python3.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
venv="$here/../aws-rewind-cli/.venv/bin/python"

if [ -x "$venv" ]; then
  python="$venv"
else
  python=$(command -v python3)
  echo "note: $venv not found, falling back to $python (live mode needs boto3)" >&2
fi

exec "$python" "$here/server/app.py" "$@"
