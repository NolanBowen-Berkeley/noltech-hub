#!/usr/bin/env bash
#
# NolTech Sync Agent — installer
#
# Idempotent installer for a fresh Raspberry Pi OS (64-bit) host. Safe to
# re-run: every step checks before mutating state. Installs Node 20, npm deps,
# and registers the systemd unit.
#
# Usage: bash scripts/install.sh
#
set -euo pipefail

# ---------- helpers --------------------------------------------------------

color()  { printf "\033[1;36m%s\033[0m\n" "$*"; }
ok()     { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn()   { printf "\033[1;33m!\033[0m %s\n" "$*"; }
err()    { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; }

need_sudo() {
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    err "This script needs root or sudo for system-level installs."
    exit 1
  fi
}

# Wrap a command in sudo only when not already root
SUDO=""
if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
fi

# ---------- 1) Friendly host check ----------------------------------------

color "==> Checking host"
if [[ -r /proc/device-tree/model ]] && grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null; then
  MODEL="$(tr -d '\0' < /proc/device-tree/model)"
  ok "Running on: $MODEL"
else
  warn "This doesn't look like a Raspberry Pi. Continuing anyway —"
  warn "the script will still work on Debian/Ubuntu hosts."
fi

need_sudo

# ---------- 2) Node.js 20 LTS ---------------------------------------------

color "==> Checking Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$CURRENT_NODE_MAJOR" -ge 20 ]]; then
    ok "Node $(node --version) already installed"
    NEED_NODE=0
  else
    warn "Node $(node --version) is too old; upgrading to 20.x"
  fi
fi

if [[ "$NEED_NODE" -eq 1 ]]; then
  color "    Installing Node.js 20 LTS via NodeSource"
  # NodeSource setup script is idempotent (just configures the apt repo)
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  ok "Installed Node $(node --version)"
fi

# ---------- 3) TLS roots ---------------------------------------------------

color "==> Checking CA certificates"
# The agent only makes HTTPS calls (Supabase, eBay, the pipeline). No browser
# runtime is needed — this used to install Chromium for a headless-browser
# scraper that is no longer part of the project.
if dpkg -s ca-certificates >/dev/null 2>&1; then
  ok "ca-certificates already installed"
else
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates
  ok "ca-certificates installed"
fi

# ---------- 4) Locate sync-agent directory --------------------------------

# Resolve the absolute path of <script>/.. → the sync-agent project root.
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
INSTALL_DIR="$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )"
RUN_USER="${SUDO_USER:-$USER}"

color "==> Project root: $INSTALL_DIR"
color "    Will run service as user: $RUN_USER"

if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  err "package.json not found in $INSTALL_DIR — wrong directory?"
  exit 1
fi

# ---------- 5) npm install -------------------------------------------------

color "==> Installing npm dependencies (production only)"
# Run as the target user so node_modules ownership is correct, not root.
if [[ "$EUID" -eq 0 && -n "${SUDO_USER:-}" ]]; then
  sudo -u "$RUN_USER" bash -lc "cd '$INSTALL_DIR' && npm ci --omit=dev || npm install --omit=dev"
else
  ( cd "$INSTALL_DIR" && (npm ci --omit=dev || npm install --omit=dev) )
fi
ok "Dependencies installed"

# Ensure logs directory exists (referenced by systemd unit)
mkdir -p "$INSTALL_DIR/logs"
chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR/logs" 2>/dev/null || true
ok "logs/ directory ready"

# ---------- 6) .env --------------------------------------------------------

color "==> Checking .env"
ENV_NEEDS_EDIT=0
if [[ -f "$INSTALL_DIR/.env" ]]; then
  ok ".env exists — leaving it alone"
else
  if [[ -f "$INSTALL_DIR/.env.example" ]]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    chown "$RUN_USER":"$RUN_USER" "$INSTALL_DIR/.env" 2>/dev/null || true
    chmod 600 "$INSTALL_DIR/.env"
    warn "Copied .env.example → .env (chmod 600). YOU MUST EDIT IT before starting the service."
    ENV_NEEDS_EDIT=1
  else
    err "No .env and no .env.example found. Cannot continue."
    exit 1
  fi
fi

# ---------- 7) systemd service --------------------------------------------

color "==> Installing systemd service"
UNIT_SRC="$SCRIPT_DIR/sync-agent.service"
UNIT_DST="/etc/systemd/system/sync-agent.service"

if [[ ! -f "$UNIT_SRC" ]]; then
  err "Unit template not found at $UNIT_SRC"
  exit 1
fi

# Render the template into a temp file with placeholders substituted, then
# only copy if the rendered content differs from what's already installed.
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT

sed \
  -e "s|__USER__|${RUN_USER}|g" \
  -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
  "$UNIT_SRC" > "$TMP_UNIT"

if [[ -f "$UNIT_DST" ]] && cmp -s "$TMP_UNIT" "$UNIT_DST"; then
  ok "systemd unit already up to date"
else
  $SUDO install -m 0644 "$TMP_UNIT" "$UNIT_DST"
  ok "Installed unit at $UNIT_DST"
  $SUDO systemctl daemon-reload
fi

# Enable on boot (idempotent)
if $SUDO systemctl is-enabled sync-agent >/dev/null 2>&1; then
  ok "sync-agent already enabled on boot"
else
  $SUDO systemctl enable sync-agent
  ok "Enabled sync-agent on boot"
fi

# IMPORTANT: do NOT auto-start. The user must edit .env first.

# ---------- 8) Final instructions -----------------------------------------

echo
color "===================================================================="
color "  Install complete."
color "===================================================================="
echo
if [[ "$ENV_NEEDS_EDIT" -eq 1 ]]; then
  warn "Edit your secrets:"
  echo "    nano $INSTALL_DIR/.env"
  echo
fi
echo "  Start the service:"
echo "    sudo systemctl start sync-agent"
echo
echo "  Watch live logs:"
echo "    journalctl -u sync-agent -f"
echo
echo "  See README.md for ops, troubleshooting, and updating."
echo
