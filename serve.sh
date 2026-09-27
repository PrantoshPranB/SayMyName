#!/usr/bin/env bash
# Microphone access needs a secure origin. file:// is not one — localhost is.
# serve.js also makes the studio's Publish button work (it pushes docs/).
set -e
cd "$(dirname "$0")"
exec node serve.js "${1:-8000}"
