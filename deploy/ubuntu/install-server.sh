#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash deploy/ubuntu/install-server.sh"
  exit 1
fi

APP_USER="${APP_USER:-synchro}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchro}"
APP_REPO_SOURCE="${APP_REPO_SOURCE:-}"
APP_PORT="${APP_PORT:-3000}"
APP_HOST="${APP_HOST:-127.0.0.1}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="${SERVICE_NAME:-synchro}"
DOMAIN_NAME="${DOMAIN_NAME:-_}"

export DEBIAN_FRONTEND=noninteractive

echo "[1/9] Installing OS packages"
apt-get update
apt-get install -y curl ca-certificates gnupg lsb-release nginx python3 python3-venv python3-pip sqlite3

echo "[2/9] Installing Node.js ${NODE_MAJOR}.x"
install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
cat >/etc/apt/sources.list.d/nodesource.list <<EOF
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF
apt-get update
apt-get install -y nodejs

echo "[3/9] Creating service account"
if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

echo "[4/9] Preparing app directories"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/data"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/storage"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/logs"

if [[ -n "${APP_REPO_SOURCE}" ]]; then
  echo "[5/9] Syncing application files from ${APP_REPO_SOURCE}"
  rsync -a \
    --delete \
    --exclude ".git/" \
    --exclude ".venv/" \
    --exclude "node_modules/" \
    --exclude "data/" \
    --exclude "storage/" \
    --exclude "companion/" \
    --exclude "companion_commander/" \
    --exclude "__pycache__/" \
    "${APP_REPO_SOURCE}/" "${APP_DIR}/"
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
else
  echo "[5/9] Skipping code sync because APP_REPO_SOURCE is not set"
fi

echo "[6/9] Installing Node dependencies"
if [[ -f "${APP_DIR}/package-lock.json" ]]; then
  su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev" "${APP_USER}"
else
  echo "package-lock.json not found in ${APP_DIR}; falling back to npm install --omit=dev"
  su -s /bin/bash -c "cd '${APP_DIR}' && npm install --omit=dev" "${APP_USER}"
fi

echo "[7/9] Creating Python virtualenv"
if [[ ! -d "${APP_DIR}/.venv" ]]; then
  su -s /bin/bash -c "python3 -m venv '${APP_DIR}/.venv'" "${APP_USER}"
fi
su -s /bin/bash -c "'${APP_DIR}/.venv/bin/pip' install --upgrade pip && '${APP_DIR}/.venv/bin/pip' install -r '${APP_DIR}/requirements-server.txt'" "${APP_USER}"

echo "[8/9] Installing systemd unit"
sed \
  -e "s|__APP_USER__|${APP_USER}|g" \
  -e "s|__APP_GROUP__|${APP_GROUP}|g" \
  -e "s|__APP_DIR__|${APP_DIR}|g" \
  -e "s|__APP_HOST__|${APP_HOST}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  "deploy/ubuntu/synchro.service" >"/etc/systemd/system/${SERVICE_NAME}.service"

echo "[9/9] Installing nginx site template"
sed \
  -e "s|__DOMAIN_NAME__|${DOMAIN_NAME}|g" \
  -e "s|__APP_HOST__|${APP_HOST}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  "deploy/ubuntu/nginx.synchro.conf" >"/etc/nginx/sites-available/${SERVICE_NAME}.conf"
ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}.conf" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
rm -f /etc/nginx/sites-enabled/default

if [[ ! -f "${APP_DIR}/.env" ]]; then
  install -o "${APP_USER}" -g "${APP_GROUP}" -m 0640 "deploy/ubuntu/env.production.example" "${APP_DIR}/.env"
  echo
  echo "Created ${APP_DIR}/.env from template. Edit it before starting the service."
fi

systemctl daemon-reload
nginx -t

cat <<EOF

Install complete.

Next steps:
1. Edit ${APP_DIR}/.env
2. Test nginx: systemctl reload nginx
3. Start app: systemctl enable --now ${SERVICE_NAME}
4. Check logs: journalctl -u ${SERVICE_NAME} -f

EOF
