#!/usr/bin/env bash
# Railway boot for the career-ops web app.
#
# The image is stateless; user-layer dirs (all gitignored upstream) live on
# the attached volume so tracker data, profiles, reports and uploads survive
# redeploys. Without a volume attached the app still boots — data is just
# ephemeral. First boot seeds the volume from the image (usually .gitkeeps).
#
# careerOpsRoot() resolves to the parent of web/, so cwd MUST be the repo
# root's web/ dir: /app/web -> root /app (where lib/ lives).

set -euo pipefail

APP_ROOT="/app"
VOLUME="${RAILWAY_VOLUME_MOUNT_PATH:-}"

if [ -n "$VOLUME" ]; then
  mkdir -p "$VOLUME"
  for d in data reports documents interview-prep output; do
    if [ ! -e "$VOLUME/$d" ] && [ -e "$APP_ROOT/$d" ]; then
      cp -R "$APP_ROOT/$d" "$VOLUME/$d"
    fi
    mkdir -p "$VOLUME/$d"
    rm -rf "$APP_ROOT/$d"
    ln -sfn "$VOLUME/$d" "$APP_ROOT/$d"
  done
fi

cd "$APP_ROOT/web"
exec npm start -- -p "${PORT:-3000}" -H 0.0.0.0
