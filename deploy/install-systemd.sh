#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/derouter-telegram-bot
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
    echo 'Run with sudo on the Linux VPS.' >&2
    exit 1
fi
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
    echo "Place the project at $APP_DIR before installing." >&2
    exit 1
fi
for executable in node npm systemctl runuser; do
    command -v "$executable" >/dev/null || { echo "Missing prerequisite: $executable" >&2; exit 1; }
done
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
    /usr/bin/node|/usr/local/bin/node) ;;
    *) echo 'Install Node system-wide at /usr/bin/node or /usr/local/bin/node.' >&2; exit 1 ;;
esac
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer required; use Node.js 24 LTS."); process.exit(1); }'
if [[ ! -s "$APP_DIR/.env" ]]; then
    echo "Copy the configured .env to $APP_DIR/.env first." >&2
    exit 1
fi

if ! id derouter >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin derouter
fi
systemctl stop derouter-bot.service 2>/dev/null || true
chown -R derouter:derouter "$APP_DIR"
chmod 700 "$APP_DIR"
chmod 600 "$APP_DIR/.env"
cd "$APP_DIR"
runuser -u derouter -- npm ci --omit=dev --no-audit --no-fund
runuser -u derouter -- npm test
sed "s|__NODE_BIN__|$NODE_BIN|g" "$APP_DIR/deploy/derouter-bot.service" > /etc/systemd/system/derouter-bot.service
systemd-analyze verify /etc/systemd/system/derouter-bot.service
systemctl daemon-reload
systemctl enable --now derouter-bot.service
systemctl --no-pager --full status derouter-bot.service
echo 'Recent logs: journalctl -u derouter-bot -n 50 --no-pager'
