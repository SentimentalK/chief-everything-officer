#!/usr/bin/env bash
# Install ceo-worker as a system-level systemd unit that runs as the
# installing user (not root, and not systemctl --user).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="${1:-}"
if [ -z "$BIN_SRC" ]; then
  if [ -x "$HERE/ceo-worker" ]; then
    BIN_SRC="$HERE/ceo-worker"
  elif [ -x "$HERE/../target/release/ceo-worker" ]; then
    BIN_SRC="$HERE/../target/release/ceo-worker"
  else
    echo "install: pass the ceo-worker binary path as argv[1]" >&2
    exit 1
  fi
fi
if [ ! -x "$BIN_SRC" ]; then
  echo "install: not an executable: $BIN_SRC" >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  INSTALL_USER="${SUDO_USER:-}"
  if [ -z "$INSTALL_USER" ] || [ "$INSTALL_USER" = "root" ]; then
    echo "install: refuse to run the worker as root; invoke via sudo from the target user" >&2
    exit 1
  fi
  SUDO=""
else
  INSTALL_USER="$(id -un)"
  SUDO="sudo"
fi

UNIT_SRC="$HERE/ceo-worker.service"
if [ ! -f "$UNIT_SRC" ]; then
  echo "install: missing $UNIT_SRC" >&2
  exit 1
fi

resolve_agy() {
  local found=""
  if [ -n "${CEO_AGENT_BIN:-}" ]; then
    found="$CEO_AGENT_BIN"
  elif command -v agy >/dev/null 2>&1; then
    found="$(command -v agy)"
  fi
  if [ -z "$found" ]; then
    echo ""
    return 0
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "$found" 2>/dev/null || echo "$found"
  else
    echo "$found"
  fi
}

AGY_BIN="$(resolve_agy)"
AGY_OK=0
if [ -n "$AGY_BIN" ] && [ "${AGY_BIN#/}" != "$AGY_BIN" ] && [ -x "$AGY_BIN" ]; then
  AGY_OK=1
fi

$SUDO install -d -m 0755 /etc/ceo/worker
$SUDO install -m 0755 "$BIN_SRC" /usr/local/bin/ceo-worker

if [ ! -f /etc/ceo/worker/bridge.json ]; then
  echo "install: /etc/ceo/worker/bridge.json is not present; create it before enabling the unit"
fi

if [ "$AGY_OK" = "1" ]; then
  AGENT_LINE="CEO_AGENT_BIN=$AGY_BIN"
else
  AGENT_LINE="CEO_AGENT_BIN=/REPLACE_WITH_ABSOLUTE_PATH_TO_agy"
fi

if [ ! -f /etc/ceo/worker/worker.env ]; then
  $SUDO tee /etc/ceo/worker/worker.env >/dev/null <<EOF
CEO_WORKSPACE_REF=tools
$AGENT_LINE
EOF
  $SUDO chmod 0644 /etc/ceo/worker/worker.env
else
  echo "install: leaving existing /etc/ceo/worker/worker.env in place"
fi

tmp_unit="$(mktemp)"
sed "s/__CEO_WORKER_USER__/${INSTALL_USER}/g" "$UNIT_SRC" >"$tmp_unit"
$SUDO install -m 0644 "$tmp_unit" /etc/systemd/system/ceo-worker.service
rm -f "$tmp_unit"
$SUDO systemctl daemon-reload

echo
echo "CEO Worker is a system-level service; the process runs as ${INSTALL_USER}."
echo "systemd will not find a bare 'agy' on PATH. worker.env must set:"
echo "  CEO_WORKSPACE_REF=tools"
echo "  CEO_AGENT_BIN=/absolute/path/to/agy"
if [ "$AGY_OK" != "1" ]; then
  echo
  echo "install: CEO_AGENT_BIN is not an executable absolute path."
  echo "edit /etc/ceo/worker/worker.env before enabling the unit."
  exit 1
fi
echo
echo "Next:"
echo "  sudo systemctl enable --now ceo-worker"
echo "(systemctl, not systemctl --user)"
