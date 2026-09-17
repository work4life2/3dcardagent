#!/usr/bin/env bash
# One-shot bootstrap of a fresh Ubuntu/Debian server (run as root):
#   packages, Node 22, nginx (+ basic auth for the dashboard), service user, swap,
#   git clone, systemd service + auto-deploy timer.
# Usage:  REPO=https://github.com/work4life2/3dcardagent.git DASH_USER=admin DASH_PASS=... bash server-bootstrap.sh
# Afterwards: put .env.local into /opt/holo-card-agent, run `npm run setup` as the service user, start the service.
set -euo pipefail

TARGET="${TARGET:-/opt/holo-card-agent}"
REPO="${REPO:-https://github.com/work4life2/3dcardagent.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-holocard}"
DASH_USER="${DASH_USER:-admin}"
DASH_PASS="${DASH_PASS:-}"
SWAP_GB="${SWAP_GB:-2}"
export DEBIAN_FRONTEND=noninteractive

echo "[bootstrap] packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl gnupg git rsync python3 python3-pil fontconfig fonts-noto-cjk fonts-dejavu-core zip unzip xz-utils \
  libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libglu1-mesa libxkbcommon0 libsm6 libice6 libegl1 libgomp1 \
  nginx apache2-utils

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  echo "[bootstrap] node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if [ "$SWAP_GB" -gt 0 ] && [ ! -f /swapfile ]; then
  echo "[bootstrap] ${SWAP_GB}G swapfile (Blender renders)"
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$SERVICE_USER" -s /bin/bash "$SERVICE_USER"

if [ ! -d "$TARGET/.git" ]; then
  echo "[bootstrap] clone $REPO -> $TARGET"
  mkdir -p "$TARGET" && chown "$SERVICE_USER:$SERVICE_USER" "$TARGET"
  runuser -u "$SERVICE_USER" -- git clone -q -b "$BRANCH" "$REPO" "$TARGET"
fi
runuser -u "$SERVICE_USER" -- mkdir -p "$TARGET/data"

if [ -n "$DASH_PASS" ]; then
  htpasswd -cbB /etc/nginx/holo-card.htpasswd "$DASH_USER" "$DASH_PASS"
  chmod 640 /etc/nginx/holo-card.htpasswd && chgrp www-data /etc/nginx/holo-card.htpasswd
fi

echo "[bootstrap] first deploy"
TARGET="$TARGET" BRANCH="$BRANCH" SERVICE_USER="$SERVICE_USER" bash "$TARGET/deploy/deploy.sh" --force || true
systemctl enable -q holo-card-agent holo-card-autodeploy.timer
systemctl start holo-card-autodeploy.timer
systemctl enable -q --now nginx
echo "[bootstrap] done"
