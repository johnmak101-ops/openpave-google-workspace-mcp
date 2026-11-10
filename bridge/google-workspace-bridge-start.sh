#!/bin/sh
# Start the google-workspace MCP bridge on loopback (idempotent).
#
# The bridge republishes the stdio-only server from $GWS_ROOT as Streamable
# HTTP, so PAVE can register it with:
#   capabilities_add http://127.0.0.1:4318/mcp
#
# Environment:
#   GWS_WORKDIR  working directory        (default /home/pave/workspace)
#   GWS_ROOT     upstream clone           (default $GWS_WORKDIR/google-workspace)
#   GWS_LOG      bridge log               (default $GWS_WORKDIR/bridge.log)
#   WORKSPACE_FEATURE_OVERRIDES  override the 4-scope default
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIR="${GWS_WORKDIR:-/home/pave/workspace}"
PORT="${1:-4318}"
GWS_ROOT="${GWS_ROOT:-$DIR/google-workspace}"
GWS_LOG="${GWS_LOG:-$DIR/bridge.log}"
export GWS_ROOT

if curl -s -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "already listening on http://127.0.0.1:${PORT}/mcp"
  exit 0
fi

if [ ! -f "$GWS_ROOT/workspace-server/dist/index.js" ]; then
  echo "server not built: $GWS_ROOT/workspace-server/dist/index.js" >&2
  echo "run:" >&2
  echo "  cd \"$GWS_ROOT\" && NODE_ENV=development npm install --include=dev --ignore-scripts" >&2
  echo "  cd \"$GWS_ROOT\" && NODE_ENV=development npm run build" >&2
  echo "  cd \"$GWS_ROOT/workspace-server\" && NODE_ENV=development node esbuild.auth-utils.js" >&2
  exit 1
fi

# Must match the scopes granted at sign-in, or AuthManager deletes the token.
#
# Empirical map of Google's unverified-app enforcement for the upstream shared
# client (2026-11-05, one consent per step):
#   2 scopes (drive, gmail.modify)                  -> PASSED (24 tools)
#   3 scopes (+documents)                            -> PASSED (30 tools)
#   4 scopes (+calendar)                             -> PASSED (38 tools)  <-- default
#   5 scopes (+spreadsheets / +presentations / +tasks.readonly) -> BLOCKED
#   6 scopes, 12 scopes                              -> BLOCKED
#
# The block is a scope-count ceiling, not a per-API verdict. The only route
# past 4 scopes is your own OAuth client with yourself as a GCP test user:
# docs/GCP-RECREATION.md in the upstream repository.
#
# Narrower tested values:
#   Gmail+Drive only (2 scopes / 24 tools):
#     docs.read:off,docs.write:off,calendar.read:off,calendar.write:off,\
#     chat.read:off,chat.write:off,people.read:off,slides.read:off,sheets.read:off
#   Gmail+Drive+Docs (3 scopes / 30 tools):
#     calendar.read:off,calendar.write:off,chat.read:off,chat.write:off,\
#     people.read:off,slides.read:off,sheets.read:off
WORKSPACE_FEATURE_OVERRIDES="${WORKSPACE_FEATURE_OVERRIDES:-chat.read:off,chat.write:off,people.read:off,slides.read:off,sheets.read:off}"
export WORKSPACE_FEATURE_OVERRIDES
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true
export GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE

if [ -f "$GWS_ROOT/gemini-cli-workspace-token.json" ]; then
  echo "token store: present"
else
  echo "token store: absent - sign in (SKILL.md section 2.3) and restart this launcher"
fi

nohup node "$SCRIPT_DIR/google-workspace-bridge.mjs" "$PORT" >> "$GWS_LOG" 2>&1 &
sleep 3

if ! curl -s -m 2 "http://127.0.0.1:${PORT}/health"; then
  echo "bridge failed to start; last log lines:" >&2
  tail -n 20 "$GWS_LOG" >&2 2>/dev/null || true
  exit 1
fi
echo
echo "ok: http://127.0.0.1:${PORT}/mcp"
