#!/usr/bin/env bash
# One-shot bootstrap + deploy for OpenBridge on a small VPS (tuned for
# 1 vCPU / 1 GB RAM). Safe to re-run — it only does the parts that are
# missing and otherwise just pulls + rebuilds.
#
# Usage on a fresh Ubuntu/Debian VPS (as root or a sudo user):
#   curl -fsSL https://raw.githubusercontent.com/hoseinrza/OpenBridge/main/deploy.sh | bash
# or, if you already copied the repo onto the server:
#   bash deploy.sh

set -euo pipefail

REPO_URL="https://github.com/hoseinrza/OpenBridge.git"
INSTALL_DIR="${OPENBRIDGE_DIR:-/opt/openbridge}"
SWAP_FILE="/swapfile"
SWAP_SIZE="2G"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# ── 1. Swap ── a 1 GB box will OOM mid-build (npm ci / vite build /
# tsc) without it. 2 GB swap is enough headroom and costs nothing idle.
if ! $SUDO swapon --show | grep -q .; then
  log "No swap found — creating ${SWAP_SIZE} swapfile"
  $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null || $SUDO dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
  $SUDO chmod 600 "$SWAP_FILE"
  $SUDO mkswap "$SWAP_FILE"
  $SUDO swapon "$SWAP_FILE"
  grep -q "$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" | $SUDO tee -a /etc/fstab >/dev/null
else
  log "Swap already configured, skipping"
fi

# ── 2. Docker ──────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
else
  log "Docker already installed, skipping"
fi

DC="docker compose"
if ! $SUDO docker compose version >/dev/null 2>&1; then
  DC="docker-compose" # fallback for older standalone installs
fi

# ── 3. Get the code ────────────────────────────────────────
if [ -f "$(dirname "$0")/docker-compose.yml" ]; then
  # Script is being run from inside an already-copied repo.
  APP_DIR="$(cd "$(dirname "$0")" && pwd)"
  log "Running from existing checkout at $APP_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
  APP_DIR="$INSTALL_DIR"
else
  log "Cloning repo into $INSTALL_DIR"
  $SUDO mkdir -p "$INSTALL_DIR"
  $SUDO chown "$(id -u)":"$(id -g)" "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  APP_DIR="$INSTALL_DIR"
fi
cd "$APP_DIR"

# ── 4. Secrets ── generated once, then left alone on redeploys ─
if [ ! -f .env ]; then
  log "Generating .env with random secrets"
  cp .env.example .env
  PG_PASS=$(openssl rand -hex 24)
  JWT_SECRET=$(openssl rand -hex 32)
  sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${PG_PASS}#" .env
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET}#" .env
else
  log ".env already exists, leaving it as-is"
fi

# ── 5. Build + start ───────────────────────────────────────
log "Building and starting containers (this can take a few minutes on 1 vCPU)"
$SUDO $DC up -d --build

log "Pruning old images to save disk space"
$SUDO docker image prune -f >/dev/null 2>&1 || true

# ── 6. Auto-redeploy on new commits (every 5 min via cron) ──
CRON_CMD="cd $APP_DIR && git fetch -q && [ \$(git rev-parse HEAD) != \$(git rev-parse @{u}) ] && git pull --ff-only -q && $DC up -d --build && docker image prune -f"
CRON_LINE="*/5 * * * * $CRON_CMD >> $APP_DIR/deploy.log 2>&1"
( $SUDO crontab -l 2>/dev/null | grep -vF "$APP_DIR"; echo "$CRON_LINE" ) | $SUDO crontab -
log "Auto-redeploy on new commits installed (checks every 5 min, see $APP_DIR/deploy.log)"

echo
echo "✅ Deployed. Open: http://$(curl -s -4 ifconfig.me || echo YOUR_SERVER_IP)/"
echo "   Logs:    $DC logs -f api"
echo "   Status:  $DC ps"
