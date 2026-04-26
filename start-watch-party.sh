#!/usr/bin/env sh
set -eu

PORT="${PORT:-3000}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SERVER_PID=""
NGROK_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$NGROK_PID" ]; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi
}

is_listening() {
  curl -fsS "http://127.0.0.1:$1" >/dev/null 2>&1
}

find_ngrok() {
  if command -v ngrok >/dev/null 2>&1; then
    command -v ngrok
    return 0
  fi

  if command -v ngrok.exe >/dev/null 2>&1; then
    command -v ngrok.exe
    return 0
  fi

  if [ -n "${LOCALAPPDATA:-}" ]; then
    candidate="$LOCALAPPDATA/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

cd "$ROOT_DIR"

if ! is_listening "$PORT"; then
  node server/index.js >/tmp/watch-party-node.log 2>&1 &
  SERVER_PID="$!"
  sleep 2
fi

if ! is_listening 4040; then
  NGROK="$(find_ngrok)" || {
    echo "ngrok was not found. Install it, add it to PATH, and configure your authtoken."
    exit 1
  }

  "$NGROK" http "$PORT" >/tmp/watch-party-ngrok.log 2>&1 &
  NGROK_PID="$!"
fi

SHARE_URL=""
attempts=0
while [ "$attempts" -lt 40 ] && [ -z "$SHARE_URL" ]; do
  SHARE_URL="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | sed -n 's/.*"public_url":"\([^"]*https:[^"]*\)".*/\1/p' | head -n 1 || true)"
  attempts=$((attempts + 1))
  sleep 0.5
done

if [ -z "$SHARE_URL" ]; then
  echo "ngrok started, but no public tunnel URL was available from http://127.0.0.1:4040."
  exit 1
fi

trap cleanup INT TERM

echo ""
echo "Watch Party is running locally:"
echo "  http://localhost:$PORT"
echo ""
echo "Share this URL:"
echo "  $SHARE_URL"
echo ""
echo "Keep this terminal open while sharing. Press Ctrl+C to stop processes started by this script."

while true; do
  sleep 3600
done
