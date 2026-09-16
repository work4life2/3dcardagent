#!/usr/bin/env bash
# Bare-metal installer for Debian/Ubuntu servers (run as root or with sudo).
#   curl -fsSL <raw url>/deploy/install.sh | sudo bash -s -- /opt/holo-card-agent
# or from a checkout:  sudo deploy/install.sh
set -euo pipefail

TARGET="${1:-/opt/holo-card-agent}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-holocard}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-pil fontconfig fonts-noto-cjk zip xz-utils \
  libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libglu1-mesa libxkbcommon0 libsm6 libice6 libegl1 libgomp1

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$SERVICE_USER" -s /bin/bash "$SERVICE_USER"

if [ "$SRC" != "$TARGET" ]; then
  mkdir -p "$TARGET"
  rsync -a --delete --exclude node_modules --exclude data --exclude dist --exclude .git "$SRC/" "$TARGET/"
fi
cd "$TARGET"
[ -f .env ] || cp .env.example .env
npm ci --ignore-scripts --no-audit --no-fund
npm run build
chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET"

sed "s/User=%i/User=$SERVICE_USER/; s#/opt/holo-card-agent#$TARGET#g" deploy/holo-card-agent.service > /etc/systemd/system/holo-card-agent.service
systemctl daemon-reload
systemctl enable holo-card-agent

cat <<EOF

[install] done. Next:
  1. edit $TARGET/.env (LLM key, image API key, AACP_CHAIN)
  2. sudo -u $SERVICE_USER bash -c 'cd $TARGET && npm run setup'          # deps + Blender + doctor
  3. sudo -u $SERVICE_USER bash -c 'cd $TARGET && npm run setup -- link'  # link Termix web account (approve on phone)
  4. sudo -u $SERVICE_USER bash -c 'cd $TARGET && npm run setup -- agents'  → put the agentId into .env A2A_AGENT_ID
  5. sudo -u $SERVICE_USER bash -c 'cd $TARGET && npm run setup -- listing'
  6. sudo systemctl start holo-card-agent && journalctl -fu holo-card-agent
EOF
