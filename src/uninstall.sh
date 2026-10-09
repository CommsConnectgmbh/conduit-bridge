#!/usr/bin/env bash
# Conduit bridge uninstaller for macOS and Linux.
#
# Removes what install.sh set up: the autostart services (launchd agents on
# macOS, systemd user units on Linux), the bridge program, the tunnel script and
# the tunnel token. Chat history, keys, configuration, logs, attachments and
# speech models are kept unless --purge is given. Before anything is removed
# the script lists every path and asks.
#
# Usage:  bash ~/.conduit/bridge/src/uninstall.sh [--purge] [--yes] [--dry-run]
#   --purge    also delete the local data listed under "Data"
#   --yes      do not ask for confirmation (for scripted removal)
#   --dry-run  only show what would be removed
#
# CONDUIT_DIR selects another install directory, as for install.sh.
set -euo pipefail

PURGE=0; YES=0; DRY=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s (use --purge, --yes, --dry-run)\n' "$a" >&2; exit 2 ;;
  esac
done

DIR="${CONDUIT_DIR:-$HOME/.conduit}"
BRIDGE_DIR="$DIR/bridge"
ENV_FILE="$BRIDGE_DIR/.env.local"
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  *) echo "Unsupported OS: use uninstall.ps1 on Windows." >&2; exit 1 ;;
esac

# A setting as the bridge saw it: .env.local (read literally, like start.sh),
# else the bridge's own default.
setting() {
  local key="$1" def="$2" line val=""
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in "$key="*) val="${line#*=}" ;; esac
    done < "$ENV_FILE"
  fi
  printf '%s' "${val:-$def}"
}
DB_DIR="$(setting DB_DIR "$HOME/Library/conduit-bridge")"
LOG_DIR="$(setting LOG_DIR "$HOME/Library/Logs/conduit-bridge")"
PASTE_DIR="$(setting PASTE_DIR "$HOME/Library/conduit-bridge/pastes")"
MODELS_DIR="$(setting CONDUIT_MODELS_DIR "$HOME/.conduit/models")"
RUNTIME_DIR="$(setting CONDUIT_SPEECH_RUNTIME_DIR "$HOME/.conduit/speech-runtime")"
IDENTITY="$(setting CONDUIT_IDENTITY_PATH "$DB_DIR/identity.key")"
SERVICE_LOG_DIR="$DIR/logs"

# Never anything that is not clearly ours. Every path is made canonical first
# (repeated and trailing slashes, "." and "..", symlinked directories resolved),
# and only the canonical form is ever deleted. Refused: empty, relative or
# top-level paths, the home directory, and anything that contains it.
canon() { # prints the canonical path, or nothing
  local p; p="$(printf '%s' "$1" | tr -s /)"   # "//", "///" and so on count as "/"
  case "$p" in /*) ;; *) return 1 ;; esac
  [ "$p" != "/" ] || return 1
  # A symlink itself (not its target) is what gets removed: keep its own path,
  # with the parent directory made canonical.
  if [ -L "${p%/}" ] && [ "${p%/}" = "$(printf '%s' "$p" | sed 's:/*$::')" ]; then
    local parent; parent="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    printf '%s/%s' "${parent%/}" "$(basename "$p")"; return 0
  fi
  if [ -d "$p" ]; then (cd -P "$p" 2>/dev/null && pwd -P); return; fi
  local parent; parent="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "${parent%/}" "$(basename "$p")"
}
HOME_CANON="$( (cd -P "$HOME" 2>/dev/null && pwd -P) || printf '%s' "${HOME%/}")"
CANON=""
safe() { # sets CANON on success
  CANON=""
  local c; c="$(canon "$1")" || return 1
  c="$(printf '%s' "$c" | tr -s /)"
  [ -n "$c" ] || return 1
  case "$c" in /*) ;; *) return 1 ;; esac
  [ "$c" != "/" ] || return 1
  [ "$c" != "$HOME_CANON" ] || return 1
  case "$HOME_CANON/" in "$c"/*) return 1 ;; esac   # an ancestor of home
  [ "$(printf '%s' "$c" | tr -cd / | wc -c)" -ge 2 ] || return 1
  CANON="$c"
}

SERVICES=(); PROGRAM=(); DATA=()
add() { # list path
  local list="$1" p="$2"
  [ -e "$p" ] || [ -L "$p" ] || return 0
  safe "$p" || { printf 'Skipping unsafe path: %s\n' "$p" >&2; return 0; }
  case "$list" in
    program) PROGRAM+=("$CANON") ;;
    data)    DATA+=("$CANON") ;;
  esac
}

if [ "$PLATFORM" = darwin ]; then
  for L in de.tryconduit.bridge de.tryconduit.tunnel; do
    [ -f "$HOME/Library/LaunchAgents/$L.plist" ] && SERVICES+=("$L")
  done
else
  for U in conduit-bridge conduit-tunnel; do
    [ -f "$HOME/.config/systemd/user/$U.service" ] && SERVICES+=("$U")
  done
fi

for f in src node_modules package.json package-lock.json .installed-files.json .selfupdate start.sh \
         LICENSE THIRD-PARTY-NOTICES.md README.md licenses; do
  add program "$BRIDGE_DIR/$f"
done
add program "$DIR/tunnel.sh"
add program "$DIR/.cloudflared-token"
add program "$DIR/bin"

# The installer's layout as well, in case .env.local is already gone.
for d in "$DB_DIR" "$BRIDGE_DIR"; do
  for f in db.sqlite db.sqlite-wal db.sqlite-shm identity.key; do
    case " ${DATA[*]-} " in *" $d/$f "*) ;; *) add data "$d/$f" ;; esac
  done
done
case " ${DATA[*]-} " in *" $IDENTITY "*) ;; *) add data "$IDENTITY" ;; esac
add data "$ENV_FILE"
add data "$PASTE_DIR"
if [ -d "$LOG_DIR" ]; then
  for f in "$LOG_DIR"/bridge.log "$LOG_DIR"/bridge.log.* "$LOG_DIR"/.alexa-session.json "$LOG_DIR"/.alexa-session-inited; do
    add data "$f"
  done
fi
add data "$SERVICE_LOG_DIR"
add data "$MODELS_DIR"
add data "$RUNTIME_DIR"

show() { local p; for p in "$@"; do printf '    %s\n' "$p"; done; }
echo "Conduit bridge uninstall ($PLATFORM)"
echo
if [ ${#SERVICES[@]} -gt 0 ]; then
  echo "  Services to stop and remove:"
  if [ "$PLATFORM" = darwin ]; then
    for L in "${SERVICES[@]}"; do printf '    launchd agent %s (%s)\n' "$L" "$HOME/Library/LaunchAgents/$L.plist"; done
  else
    for U in "${SERVICES[@]}"; do printf '    systemd user unit %s (%s)\n' "$U" "$HOME/.config/systemd/user/$U.service"; done
  fi
else
  echo "  Services: none found"
fi
if [ ${#PROGRAM[@]} -gt 0 ]; then echo "  Program files to remove:"; show "${PROGRAM[@]}"; else echo "  Program files: none found"; fi
if [ ${#DATA[@]} -gt 0 ]; then
  if [ "$PURGE" = 1 ]; then echo "  Data to DELETE (chat history, keys, configuration, logs, attachments, speech models):"
  else echo "  Data kept (run with --purge to delete it):"; fi
  show "${DATA[@]}"
else
  echo "  Data: none found"
fi
echo "  Not touched: the AI command line tools (claude, codex, agy) and their own"
echo "  conversation histories, Node.js, a cloudflared installed by a package"
echo "  manager, and this bridge's tunnel registration in the Conduit cloud."
if [ "$PLATFORM" = linux ]; then
  echo "  The installer enabled 'loginctl enable-linger' for $USER. It stays on;"
  echo "  run 'loginctl disable-linger $USER' if nothing else needs it."
fi
echo

if [ "$DRY" = 1 ]; then echo "Dry run: nothing was changed."; exit 0; fi
if [ ${#SERVICES[@]} -eq 0 ] && [ ${#PROGRAM[@]} -eq 0 ] && { [ "$PURGE" = 0 ] || [ ${#DATA[@]} -eq 0 ]; }; then
  echo "Nothing to remove."; exit 0
fi
if [ "$YES" != 1 ]; then
  if [ -r /dev/tty ] && { exec 3</dev/tty; } 2>/dev/null; then
    printf 'Proceed? [y/N] '
    read -r answer <&3 || answer=""
    exec 3<&-
    case "$answer" in y|Y|yes|YES) ;; *) echo "Aborted, nothing was changed."; exit 1 ;; esac
  else
    echo "No terminal to confirm on. Re-run with --yes to proceed." >&2; exit 1
  fi
fi

if [ "$PLATFORM" = darwin ]; then
  uid="$(id -u)"
  for L in ${SERVICES[@]+"${SERVICES[@]}"}; do
    launchctl bootout "gui/$uid/$L" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$L.plist"
    printf 'Removed service %s\n' "$L"
  done
else
  for U in ${SERVICES[@]+"${SERVICES[@]}"}; do
    systemctl --user disable --now "$U.service" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$U.service"
    printf 'Removed service %s\n' "$U"
  done
  if [ ${#SERVICES[@]} -gt 0 ]; then systemctl --user daemon-reload 2>/dev/null || true; fi
fi

for p in ${PROGRAM[@]+"${PROGRAM[@]}"}; do rm -rf -- "$p"; done
[ ${#PROGRAM[@]} -gt 0 ] && echo "Removed the program files"
if [ "$PURGE" = 1 ]; then
  for p in ${DATA[@]+"${DATA[@]}"}; do rm -rf -- "$p"; done
  [ ${#DATA[@]} -gt 0 ] && echo "Deleted the local data"
  # Directories that are now empty, innermost first.
  for d in "$LOG_DIR" "$DB_DIR" "$(dirname "$PASTE_DIR")" "$BRIDGE_DIR" "$DIR"; do
    safe "$d" && rmdir "$CANON" 2>/dev/null || true
  done
fi
echo "Done."
