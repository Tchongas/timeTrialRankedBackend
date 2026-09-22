#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/time-trial-ranked"
SERVICE_NAME="time-trial-ranked"
SERVICE_USER="timetrial"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this installer as root: sudo bash install.sh"
    exit 1
fi

if [[ ! -f "${SOURCE_DIR}/package.json" ]]; then
    echo "package.json was not found beside install.sh"
    exit 1
fi

echo "[1/7] Installing Node.js and build requirements..."
apt-get update
apt-get install -y nodejs npm build-essential python3 ca-certificates curl

NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 18 ]]; then
    echo "Node.js 18 or newer is required. Installed version: $(node --version)"
    echo "Upgrade Node.js for this VPS distribution, then run this installer again."
    exit 1
fi

echo "[2/7] Creating service account and application directory..."
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${APP_DIR}" "${APP_DIR}/data"

echo "[3/7] Copying application files..."
if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
    tar --exclude='./node_modules' --exclude='./data' --exclude='./.env' -C "${SOURCE_DIR}" -cf - . | tar -C "${APP_DIR}" -xf -
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
    cat > "${APP_DIR}/.env" <<'ENV'
PORT=3000
DATABASE_PATH=./data/time-trial.sqlite
TRACKED_USERNAMES=HumorEpiadas
POLL_INTERVAL_MS=5000
ALLOWED_ORIGINS=
ENV
    echo "Created ${APP_DIR}/.env with public read access."
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"

echo "[4/7] Installing production dependencies..."
cd "${APP_DIR}"
runuser -u "${SERVICE_USER}" -- npm ci --omit=dev

echo "[5/7] Installing systemd service..."
cp "${APP_DIR}/time-trial-ranked.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

echo "[6/7] Enabling and starting service..."
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "[7/7] Checking API health..."
for attempt in {1..10}; do
    if curl --fail --silent "http://127.0.0.1:3000/health" >/dev/null; then
        echo "Time Trial Ranked is running: http://127.0.0.1:3000/health"
        echo "Configuration: ${APP_DIR}/.env"
        exit 0
    fi
    sleep 1
done

echo "The service did not become healthy. Recent logs:"
journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
exit 1
