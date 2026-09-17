#!/usr/bin/env bash
# Pull-based deploy: fetch origin/<branch>; if it moved (or --force), reset the checkout to it,
# install, build and restart the service. Run as root (it drops to the service user for git/npm).
#   deploy/deploy.sh            # deploy only if origin moved
#   deploy/deploy.sh --force    # always rebuild + restart
set -euo pipefail

TARGET="${TARGET:-/opt/holo-card-agent}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-holocard}"
SERVICE="${SERVICE:-holo-card-agent}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

as_user() { runuser -u "$SERVICE_USER" -- "$@"; }

cd "$TARGET"
as_user git fetch -q origin "$BRANCH"
LOCAL="$(as_user git rev-parse HEAD)"
REMOTE="$(as_user git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = 0 ]; then
  exit 0
fi

echo "[deploy] $LOCAL -> $REMOTE"
as_user git reset -q --hard "origin/$BRANCH"
as_user npm ci --ignore-scripts --no-audit --no-fund
as_user npm run build
for d in web-holographic web-lenticular; do
  if [ ! -f "skills/holo-card-studio/assets/$d/node_modules/three/package.json" ]; then
    (cd "skills/holo-card-studio/assets/$d" && as_user npm install --ignore-scripts --no-audit --no-fund)
  fi
done

# Re-install the unit files in case they changed, then restart.
install -m 644 deploy/holo-card-agent.service /etc/systemd/system/holo-card-agent.service
sed -i "s/User=%i/User=$SERVICE_USER/; s#/opt/holo-card-agent#$TARGET#g" /etc/systemd/system/holo-card-agent.service
install -m 644 deploy/holo-card-autodeploy.service deploy/holo-card-autodeploy.timer /etc/systemd/system/
if [ -f deploy/nginx.conf ] && [ -d /etc/nginx/sites-enabled ]; then
  install -m 644 deploy/nginx.conf /etc/nginx/sites-available/holo-card-agent
  ln -sf /etc/nginx/sites-available/holo-card-agent /etc/nginx/sites-enabled/holo-card-agent
  rm -f /etc/nginx/sites-enabled/default
  nginx -t -q && systemctl reload nginx || echo "[deploy] nginx config invalid, not reloaded" >&2
fi
systemctl daemon-reload
systemctl restart "$SERVICE"
echo "[deploy] done: $(as_user git log -1 --format='%h %s')"
