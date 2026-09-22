#!/usr/bin/env bash
#
# Time Trial Ranked - one-command installer for Ubuntu/Debian (Oracle Cloud friendly).
#
# Usage:
#   git clone https://github.com/<you>/TimeTrialRankedBackend.git
#   cd TimeTrialRankedBackend
#   sudo bash install.sh
#
# Re-running is safe: existing .env and SQLite data are preserved.
#
set -Eeuo pipefail

APP_DIR="/opt/time-trial-ranked"
SERVICE_NAME="time-trial-ranked"
SERVICE_USER="timetrial"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MIN_MAJOR=18
NODE_SETUP_MAJOR=20
DEFAULT_PORT=3001

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Run this installer as root: sudo bash install.sh"
[[ -f "${SOURCE_DIR}/package.json" ]] || die "package.json was not found beside install.sh"

# ---------------------------------------------------------------------------
# Wait for cloud-init / unattended-upgrades to release the apt lock.
# ---------------------------------------------------------------------------
wait_for_apt() {
    local waited=0
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
       || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
        if [[ ${waited} -eq 0 ]]; then
            log "Another apt process is running (probably cloud-init). Waiting..."
        fi
        sleep 3
        waited=$((waited + 3))
        if [[ ${waited} -ge 300 ]]; then
            die "Timed out waiting for the apt lock after 5 minutes."
        fi
    done
}

apt_install() {
    wait_for_apt
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

node_major() {
    command -v node >/dev/null 2>&1 \
        && node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' \
        || echo "0"
}

# ---------------------------------------------------------------------------
# Step 1: Node.js >= 18 and build tools.
# ---------------------------------------------------------------------------
log "[1/8] Installing Node.js and build requirements..."
wait_for_apt
apt-get update

if [[ "$(node_major)" -lt "${NODE_MIN_MAJOR}" ]]; then
    log "Node.js $(node --version 2>/dev/null || echo 'not installed') is too old or missing."
    log "Installing Node.js ${NODE_SETUP_MAJOR}.x from NodeSource..."

    # Distro nodejs/npm packages conflict with NodeSource builds; remove them.
    for pkg in npm nodejs libnode-dev; do
        if dpkg -s "${pkg}" >/dev/null 2>&1; then
            apt-get remove -y "${pkg}" || warn "Could not remove ${pkg}; continuing."
        fi
    done

    apt_install ca-certificates curl gnupg
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP_MAJOR}.x" | bash -
    apt_install nodejs
else
    # A distro npm package can still conflict on systems that mixed sources.
    if dpkg -s npm >/dev/null 2>&1 && ! dpkg -s nodejs 2>/dev/null | grep -q nodesource; then
        warn "Removing distro npm package to avoid NodeSource conflicts."
        apt-get remove -y npm || true
    fi
fi

apt_install build-essential python3

command -v node >/dev/null 2>&1 || die "node is still not on PATH after installation."
command -v npm  >/dev/null 2>&1 || die "npm is still not on PATH after installation."
[[ "$(node_major)" -ge "${NODE_MIN_MAJOR}" ]] \
    || die "Node.js ${NODE_MIN_MAJOR}+ required, found $(node --version)."

log "Using node $(node --version), npm $(npm --version)."

# ---------------------------------------------------------------------------
# Step 2: Swap. better-sqlite3 compiles a native module; on a 1 GB instance the
# build can be OOM-killed. Ensure at least ~1.5 GB of total memory+swap.
# ---------------------------------------------------------------------------
log "[2/8] Checking memory/swap for the native build..."
TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
TOTAL_SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)

if [[ $((TOTAL_MEM_MB + TOTAL_SWAP_MB)) -lt 1500 && ! -f /swapfile.timetrial ]]; then
    log "Only ${TOTAL_MEM_MB} MB RAM and ${TOTAL_SWAP_MB} MB swap - creating a 1 GB swapfile..."
    fallocate -l 1G /swapfile.timetrial || dd if=/dev/zero of=/swapfile.timetrial bs=1M count=1024
    chmod 600 /swapfile.timetrial
    mkswap /swapfile.timetrial
    swapon /swapfile.timetrial
    grep -q '/swapfile.timetrial' /etc/fstab \
        || echo '/swapfile.timetrial none swap sw 0 0' >> /etc/fstab
    log "Swap enabled (persistent via /etc/fstab)."
else
    log "Memory check OK (${TOTAL_MEM_MB} MB RAM, ${TOTAL_SWAP_MB} MB swap)."
fi

# ---------------------------------------------------------------------------
# Step 3: Service account and application directory.
# ---------------------------------------------------------------------------
log "[3/8] Creating service account and application directory..."
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${APP_DIR}" "${APP_DIR}/data"

# ---------------------------------------------------------------------------
# Step 4: Copy application files (preserving .env and data/ on re-runs).
# ---------------------------------------------------------------------------
log "[4/8] Copying application files..."
if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
    tar --exclude='./node_modules' --exclude='./data' --exclude='./.env' --exclude='./.git' \
        -C "${SOURCE_DIR}" -cf - . | tar -C "${APP_DIR}" -xf -
fi

# ---------------------------------------------------------------------------
# Step 5: .env with a port that is actually free.
# ---------------------------------------------------------------------------
log "[5/8] Configuring environment..."
port_in_use() { ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"; }

if [[ ! -f "${APP_DIR}/.env" ]]; then
    PORT_CHOSEN="${DEFAULT_PORT}"
    while port_in_use "${PORT_CHOSEN}" && [[ "${PORT_CHOSEN}" -lt $((DEFAULT_PORT + 20)) ]]; do
        PORT_CHOSEN=$((PORT_CHOSEN + 1))
    done
    if port_in_use "${PORT_CHOSEN}"; then
        warn "No free port found between ${DEFAULT_PORT} and $((DEFAULT_PORT + 19)); using ${DEFAULT_PORT} anyway."
        PORT_CHOSEN="${DEFAULT_PORT}"
    fi
    cat > "${APP_DIR}/.env" <<ENV
PORT=${PORT_CHOSEN}
DATABASE_PATH=./data/time-trial.sqlite
TRACKED_USERNAMES=HumorEpiadas
POLL_INTERVAL_MS=5000
ALLOWED_ORIGINS=
ENV
    log "Created ${APP_DIR}/.env (PORT=${PORT_CHOSEN}, public read access)."
else
    PORT_CHOSEN="$(grep -E '^PORT=' "${APP_DIR}/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
    PORT_CHOSEN="${PORT_CHOSEN:-${DEFAULT_PORT}}"
    log "Keeping existing ${APP_DIR}/.env (PORT=${PORT_CHOSEN})."
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"

# ---------------------------------------------------------------------------
# Step 6: Dependencies. Limit memory usage on small instances.
# ---------------------------------------------------------------------------
log "[6/8] Installing production dependencies..."
cd "${APP_DIR}"
runuser -u "${SERVICE_USER}" -- env \
    NODE_OPTIONS=--max-old-space-size=512 \
    npm ci --omit=dev --no-audit --no-fund --jobs=1

# ---------------------------------------------------------------------------
# Step 7: systemd service.
# ---------------------------------------------------------------------------
log "[7/8] Installing systemd service..."
cp "${APP_DIR}/time-trial-ranked.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# ---------------------------------------------------------------------------
# Step 8: Firewall + health check.
# ---------------------------------------------------------------------------
log "[8/8] Checking firewall and API health..."

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
    ufw allow "${PORT_CHOSEN}/tcp" >/dev/null && log "ufw: opened port ${PORT_CHOSEN}/tcp."
elif command -v iptables >/dev/null 2>&1; then
    # Oracle Cloud images ship iptables rules that reject non-established input.
    if ! iptables -C INPUT -p tcp --dport "${PORT_CHOSEN}" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT 5 -p tcp --dport "${PORT_CHOSEN}" -j ACCEPT \
            && log "iptables: opened port ${PORT_CHOSEN}/tcp (runtime rule)."
    fi
fi

HEALTHY=0
for attempt in {1..15}; do
    if curl --fail --silent "http://127.0.0.1:${PORT_CHOSEN}/health" >/dev/null; then
        HEALTHY=1
        break
    fi
    sleep 1
done

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

if [[ "${HEALTHY}" -eq 1 ]]; then
    cat <<EOF

============================================================
 Time Trial Ranked is running.
============================================================
 Local health:   http://127.0.0.1:${PORT_CHOSEN}/health
 Public API:     http://${PUBLIC_IP:-<VPS-IP>}:${PORT_CHOSEN}/api/time-trial/players
 Config:         ${APP_DIR}/.env
 Logs:           sudo journalctl -u ${SERVICE_NAME} -f

 NOTE: On Oracle Cloud you must ALSO open port ${PORT_CHOSEN}/tcp
 in the VCN Security List (Networking -> Security Lists) or
 external traffic will still be blocked.
============================================================
EOF
    exit 0
fi

warn "The service did not become healthy. Recent logs:"
journalctl -u "${SERVICE_NAME}" -n 50 --no-pager || true
exit 1
