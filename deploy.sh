#!/usr/bin/env bash
# Bootstrap + staged redeploy for OpenBridge on a small VPS (tuned for
# 1 vCPU / 1 GB RAM). Both modes are safe to re-run.
#
#   Bootstrap (fresh server, as root or a sudo user):
#     curl -fsSL https://raw.githubusercontent.com/hoseinrza/OpenBridge/main/deploy.sh | bash
#     bash deploy.sh                    # from a checkout you copied yourself
#
#   Redeploy (what the Deploy workflow and the installed cron call):
#     bash deploy.sh --redeploy [--ref <sha>] [--skip-ci-check]
#
# A redeploy always runs the same stages, in order: pick the commit, refuse it
# if CI is not green, back up the database, build the images without touching
# the running stack, swap the containers, prove the app answers through nginx,
# and roll back to the previous commit if it never gets there.

set -euo pipefail

REPO_URL="https://github.com/hoseinrza/OpenBridge.git"
INSTALL_DIR="${OPENBRIDGE_DIR:-/opt/openbridge}"
SWAP_FILE="/swapfile"
SWAP_SIZE="2G"
HEALTH_PATH="/api/health"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
# Overridable because the first boot has to run `prisma db push` before the API
# answers, and a 1 vCPU box needs a lot longer to do that than a big one.
HEALTH_DEADLINE="${HEALTH_DEADLINE:-240}"
FAILED_SHA_FILE=".deploy-failed-sha"

MODE=bootstrap
TARGET_REF=""
CI_GATE=true
INSTALL_CRON=true
SUDO=""
DC="docker compose"
APP_DIR=""

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
warn() { printf '\n\033[1;33m! %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy.sh [--redeploy] [--ref <sha>] [--skip-ci-check] [--no-cron]

  (no flags)         Full bootstrap: swap, Docker, code, .env, build, up, cron.
  --redeploy         Staged redeploy of the newest commit (or --ref) with
                     backup, health verification and automatic rollback.
  --ref <sha>        Deploy this exact commit instead of the branch tip.
  --skip-ci-check    Deploy even when CI has not reported success.
  --no-cron          Do not (re)install the auto-redeploy cron entry.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --redeploy) MODE=redeploy ;;
    --ref)  [ $# -ge 2 ] || die "--ref needs a commit SHA"; TARGET_REF="$2"; shift ;;
    --skip-ci-check) CI_GATE=false ;;
    --no-cron) INSTALL_CRON=false ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || SUDO="sudo"

compose() { $SUDO $DC "$@"; }

# ── Shared checks ──────────────────────────────────────────
require_docker() {
  if [ "$MODE" = bootstrap ] && ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker"
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker
  fi
  command -v docker >/dev/null 2>&1 || die "Docker is not installed — run 'bash deploy.sh' (bootstrap) first"
  if $SUDO docker compose version >/dev/null 2>&1; then
    DC="docker compose"
  else
    DC="docker-compose" # older standalone installs
  fi
}

# ── Stage: health ──────────────────────────────────────────
# Asking nginx for the API's health route proves the whole chain
# (web container → proxy → api container → database-backed boot) instead of
# just checking that a process is running.
healthy() {
  compose exec -T web sh -c "wget -q -O- http://127.0.0.1$HEALTH_PATH" 2>/dev/null \
    | grep -q '"status":"ok"' \
    && compose exec -T livekit sh -c "wget -q -O- http://127.0.0.1:7880/" 2>/dev/null \
    | grep -q 'OK'
}

wait_healthy() {
  local deadline="${1:-$HEALTH_DEADLINE}" waited=0
  while [ "$waited" -lt "$deadline" ]; do
    if healthy; then
      log "Healthy after ${waited}s"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

report_failure() {
  compose ps || true
  compose logs --no-color api 2>/dev/null | tail -50 || true
  compose logs --no-color livekit 2>/dev/null | tail -30 || true
}

# ── Stage: CI gate ─────────────────────────────────────────
# Best-effort for the cron path (the Deploy workflow already gates on CI
# success). Returns green / red / pending / unknown; an unreachable API must
# not strand the server, so that case degrades to "unknown" and we proceed.
ci_state() {
  local sha="$1" repo body
  repo=$($SUDO git -C "$APP_DIR" config --get remote.origin.url 2>/dev/null \
    | sed -E 's#.*github\.com[:/]##; s#\.git$##')
  [ -n "$repo" ] || { echo unknown; return; }
  # GitHub returns pretty-printed JSON; compacting it makes the greps below
  # depend on key order only, not on whitespace.
  body=$(curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&per_page=5" \
    | tr -d '[:space:]') || { echo unknown; return; }
  if printf '%s' "$body" | grep -q '"status":"completed","conclusion":"success"'; then
    echo green
  elif printf '%s' "$body" | grep -q '"status":"completed"'; then
    echo red
  elif printf '%s' "$body" | grep -q '"total_count":0'; then
    echo pending # CI has not registered this commit yet
  else
    echo unknown
  fi
}

# ── Stage: backup ──────────────────────────────────────────
backup_db() {
  if ! compose ps --quiet postgres >/dev/null 2>&1; then
    warn "No running postgres container — skipping the pre-deploy backup"
    return 0
  fi
  $SUDO mkdir -p "$APP_DIR/backups"
  local out="backups/openbridge-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  log "Backing up the database to $APP_DIR/$out"
  $SUDO bash -c "cd '$APP_DIR' && $DC exec -T postgres pg_dump -U openbridge openbridge | gzip > '$out'" \
    || die "pg_dump failed — refusing to redeploy without a backup"
  $SUDO bash -c "cd '$APP_DIR' && ls -1t backups/*.sql.gz | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f"
}

# ── Bootstrap ──────────────────────────────────────────────
bootstrap_swap() {
  if ! $SUDO swapon --show | grep -q .; then
    log "No swap found — creating ${SWAP_SIZE} swapfile"
    $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null \
      || $SUDO dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
    $SUDO chmod 600 "$SWAP_FILE"
    $SUDO mkswap "$SWAP_FILE"
    $SUDO swapon "$SWAP_FILE"
    grep -q "$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" | $SUDO tee -a /etc/fstab >/dev/null
  else
    log "Swap already configured, skipping"
  fi
}

bootstrap_checkout() {
  if [ -f "$(dirname "$0")/docker-compose.yml" ]; then
    APP_DIR="$(cd "$(dirname "$0")" && pwd)"
    log "Running from existing checkout at $APP_DIR"
  elif [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing checkout at $INSTALL_DIR"
    $SUDO git -C "$INSTALL_DIR" pull --ff-only
    APP_DIR="$INSTALL_DIR"
  else
    log "Cloning repo into $INSTALL_DIR"
    $SUDO mkdir -p "$INSTALL_DIR"
    $SUDO chown "$(id -u)":"$(id -g)" "$INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    APP_DIR="$INSTALL_DIR"
  fi
  cd "$APP_DIR"
}

ensure_env() {
  if [ ! -f .env ]; then
    log "Generating .env with random secrets"
    cp .env.example .env
    local pg_pass jwt_secret livekit_key livekit_secret public_ip
    pg_pass=$(openssl rand -hex 24)
    jwt_secret=$(openssl rand -hex 32)
    livekit_key="lk_$(openssl rand -hex 12)"
    livekit_secret=$(openssl rand -hex 32)
    sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${pg_pass}#" .env
    sed -i "s#^JWT_SECRET=.*#JWT_SECRET=${jwt_secret}#" .env
    sed -i "s#^LIVEKIT_API_KEY=.*#LIVEKIT_API_KEY=${livekit_key}#" .env
    sed -i "s#^LIVEKIT_API_SECRET=.*#LIVEKIT_API_SECRET=${livekit_secret}#" .env

    # The browser must reach the media server over the same public host. This
    # bootstrap is HTTP-only; switch to wss:// once TLS is terminated in front.
    public_ip=$(curl -s -4 --max-time 5 ifconfig.me || true)
    if [ -n "$public_ip" ]; then
      sed -i "s#^LIVEKIT_URL=.*#LIVEKIT_URL=ws://${public_ip}/livekit#" .env
    fi
  else
    log ".env already exists, leaving it as-is"
    # An older deployment predates calls. Add the media keys once, without ever
    # rotating a value the operator may already have configured.
    local livekit_key livekit_secret public_ip
    if ! grep -q '^LIVEKIT_API_KEY=' .env; then
      livekit_key="lk_$(openssl rand -hex 12)"
      livekit_secret=$(openssl rand -hex 32)
      printf '\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$livekit_key" "$livekit_secret" >> .env
      log "Added LiveKit credentials to .env"
    fi
    if ! grep -q '^LIVEKIT_API_URL=' .env; then
      printf 'LIVEKIT_API_URL=http://livekit:7880\n' >> .env
    fi
    if ! grep -q '^LIVEKIT_URL=' .env; then
      public_ip=$(curl -s -4 --max-time 5 ifconfig.me || true)
      printf 'LIVEKIT_URL=ws://%s/livekit\n' "${public_ip:-YOUR_SERVER_IP}" >> .env
    fi
  fi
}

install_cron() {
  local cron_line
  cron_line="*/5 * * * * cd $APP_DIR && bash deploy.sh --redeploy >> $APP_DIR/deploy.log 2>&1"
  # deploy.log is also how the older, un-gated pull-and-rebuild entry looks,
  # so filtering on it removes that one instead of stacking a second job.
  ( $SUDO crontab -l 2>/dev/null | grep -vF "$APP_DIR/deploy.log"; echo "$cron_line" ) | $SUDO crontab -
  log "Auto-redeploy installed (every 5 min, staged: see $APP_DIR/deploy.log)"
}

run_bootstrap() {
  bootstrap_swap
  require_docker
  bootstrap_checkout
  ensure_env

  log "Stopping any previous containers for a clean start"
  compose down --remove-orphans 2>/dev/null || true

  log "Building and starting containers (this can take a few minutes on 1 vCPU)"
  compose up -d --build

  log "Pruning old images to save disk space"
  $SUDO docker image prune -f >/dev/null 2>&1 || true

  if wait_healthy; then
    log "Stack is serving traffic"
  else
    warn "Health check did not pass — inspect the containers before trusting this deploy"
    report_failure
  fi

  if [ "$INSTALL_CRON" = true ]; then
    install_cron
  fi

  echo
  echo "✅ Deployed. Open: http://$(curl -s -4 ifconfig.me || echo YOUR_SERVER_IP)/"
  echo "   Health:  curl http://YOUR_SERVER_IP$HEALTH_PATH"
  echo "   Logs:    $DC logs -f api"
  echo "   Status:  $DC ps"
}

# ── Redeploy ───────────────────────────────────────────────
run_redeploy() {
  require_docker
  [ -f docker-compose.yml ] && [ -d .git ] || die "No checkout here — run 'bash deploy.sh' to bootstrap first"
  APP_DIR="$(pwd)"
  [ -f .env ] || die ".env is missing — run 'bash deploy.sh' to bootstrap first"

  log "Stage 1/7 · Fetching the latest commits"
  $SUDO git -C "$APP_DIR" fetch --quiet origin

  local target
  if [ -n "$TARGET_REF" ]; then
    target=$($SUDO git -C "$APP_DIR" rev-parse --verify "$TARGET_REF^{commit}" 2>/dev/null) \
      || die "Commit $TARGET_REF is not reachable from this checkout"
  else
    target=$($SUDO git -C "$APP_DIR" rev-parse origin/main)
  fi
  local current
  current=$($SUDO git -C "$APP_DIR" rev-parse HEAD)
  log "Stage 1/7 · Target ${target:0:7} (currently ${current:0:7})"

  if [ "$target" = "$current" ] && healthy; then
    log "Already on ${target:0:7} and healthy — nothing to do"
    return 0
  fi

  local failed_sha=""
  [ -f "$FAILED_SHA_FILE" ] && failed_sha=$(cat "$FAILED_SHA_FILE")
  if [ -n "$TARGET_REF" ]; then
    : # an explicit --ref means the operator wants this commit regardless
  elif [ -n "$failed_sha" ] && [ "$failed_sha" = "$target" ]; then
    warn "Skipping ${target:0:7}: it failed its health check on the last attempt. Fix main, or deploy a different commit with --ref."
    return 0
  fi

  log "Stage 2/7 · Checking CI for ${target:0:7}"
  local state
  state=$(ci_state "$target")
  case "$state" in
    green)   log "CI is green for ${target:0:7}" ;;
    red)     warn "CI reports failure for ${target:0:7} — not deploying (use --skip-ci-check to force)"; return 0 ;;
    pending) log "CI has not finished for ${target:0:7} — retrying next cycle"; return 0 ;;
    *)       warn "CI status unavailable ($state) — proceeding; the Deploy workflow is the authoritative gate" ;;
  esac
  if [ "$CI_GATE" != true ]; then
    warn "Stage 2 skipped on request (--skip-ci-check)"
  fi

  if ! $SUDO git -C "$APP_DIR" diff --quiet HEAD; then
    die "The server checkout has local modifications — commit, stash or reset them before redeploying"
  fi
  local previous="$current"
  $SUDO git -C "$APP_DIR" checkout --quiet --detach "$target"
  log "Stage 3/7 · Checked out ${target:0:7} (rollback target: ${previous:0:7})"

  log "Stage 4/7 · Backing up the database"
  backup_db

  log "Stage 5/7 · Building images (the running stack is untouched until this succeeds)"
  if ! compose build; then
    warn "Image build failed — restoring ${previous:0:7}"
    $SUDO git -C "$APP_DIR" checkout --quiet --detach "$previous"
    compose up -d || true
    printf '%s\n' "$target" > "$FAILED_SHA_FILE"
    die "Build failed for ${target:0:7}"
  fi

  log "Stage 6/7 · Swapping containers"
  compose up -d

  log "Stage 7/7 · Waiting for the app to answer through nginx (up to ${HEALTH_DEADLINE}s)"
  if wait_healthy "$HEALTH_DEADLINE"; then
    rm -f "$FAILED_SHA_FILE"
    $SUDO docker image prune -f >/dev/null 2>&1 || true
    log "Deployed ${target:0:7} ✅"
    return 0
  fi

  warn "Never became healthy — rolling back to ${previous:0:7}"
  printf '%s\n' "$target" > "$FAILED_SHA_FILE"
  report_failure
  $SUDO git -C "$APP_DIR" checkout --quiet --detach "$previous"
  compose up -d --build
  if wait_healthy "$HEALTH_DEADLINE"; then
    die "Rolled back to ${previous:0:7} and it is healthy again. ${target:0:7} is blocked from auto-deploy until main moves."
  else
    die "Rollback to ${previous:0:7} did not become healthy either — this needs a human: $DC ps && $DC logs api"
  fi
}

case "$MODE" in
  bootstrap) run_bootstrap ;;
  redeploy)  run_redeploy ;;
esac
