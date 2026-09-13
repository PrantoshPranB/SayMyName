#!/usr/bin/env bash
# Microphone access needs a secure origin. file:// is not one — localhost is.
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "→ http://localhost:$PORT"
python3 -m http.server "$PORT"
