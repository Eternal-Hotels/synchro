#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_SOURCE="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEFAULT_GIT_URL="https://github.com/Eternal-Hotels/synchro.git"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash deploy/ubuntu/install-server.sh"
  exit 1
fi

APP_USER="${APP_USER:-synchro}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchro}"
APP_REPO_SOURCE="${APP_REPO_SOURCE:-${DEFAULT_REPO_SOURCE}}"
APP_GIT_URL="${APP_GIT_URL-${DEFAULT_GIT_URL}}"
APP_GIT_REF="${APP_GIT_REF:-}"
APP_PORT="${APP_PORT:-3000}"
APP_HOST="${APP_HOST:-127.0.0.1}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="${SERVICE_NAME:-synchro}"
DOMAIN_NAME="${DOMAIN_NAME:-reports.gascofuel.com}"
APP_PARENT_DIR="$(dirname "${APP_DIR}")"

INSTALL_MODE=""
INSTALL_SOURCE_LABEL=""
SOURCE_REMOTE_URL=""

export DEBIAN_FRONTEND=noninteractive

validate_repo_source() {
  if [[ ! -d "${APP_REPO_SOURCE}" ]]; then
    echo "APP_REPO_SOURCE does not exist: ${APP_REPO_SOURCE}"
    exit 1
  fi

  if [[ ! -f "${APP_REPO_SOURCE}/package.json" ]]; then
    echo "APP_REPO_SOURCE is not the Synchro repo root: ${APP_REPO_SOURCE}"
    echo "Expected to find: ${APP_REPO_SOURCE}/package.json"
    exit 1
  fi

  if [[ ! -f "${APP_REPO_SOURCE}/package-lock.json" ]]; then
    echo "APP_REPO_SOURCE is missing package-lock.json: ${APP_REPO_SOURCE}"
    exit 1
  fi
}

if [[ -n "${APP_GIT_URL}" ]]; then
  INSTALL_MODE="git_remote"
  INSTALL_SOURCE_LABEL="${APP_GIT_URL}"
else
  validate_repo_source
  if [[ -d "${APP_REPO_SOURCE}/.git" ]]; then
    INSTALL_MODE="git_local"
    INSTALL_SOURCE_LABEL="${APP_REPO_SOURCE}"
  else
    INSTALL_MODE="rsync"
    INSTALL_SOURCE_LABEL="${APP_REPO_SOURCE}"
  fi
fi

if [[ -n "${APP_GIT_REF}" && "${INSTALL_MODE}" == "rsync" ]]; then
  echo "APP_GIT_REF requires a git checkout source. Set APP_GIT_URL or point APP_REPO_SOURCE at a git repo."
  exit 1
fi

echo "[1/9] Installing OS packages"
apt-get update
apt-get install -y curl ca-certificates git gnupg lsb-release nginx python3 python3-venv python3-pip sqlite3 rsync

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

if [[ "${INSTALL_MODE}" == "git_local" ]]; then
  SOURCE_REMOTE_URL="$(git -C "${APP_REPO_SOURCE}" remote get-url origin 2>/dev/null || true)"
fi

echo "[4/9] Preparing app checkout and runtime directories"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_PARENT_DIR}"

if [[ "${INSTALL_MODE}" == "git_remote" || "${INSTALL_MODE}" == "git_local" ]]; then
  if [[ -d "${APP_DIR}" && -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "APP_DIR already exists and is not empty: ${APP_DIR}"
    echo "Git-clone install mode expects an empty target directory."
    exit 1
  fi

  if [[ -d "${APP_DIR}" ]]; then
    rmdir "${APP_DIR}"
  fi
else
  install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}"
fi

echo "[5/9] Installing application files"
if [[ "${INSTALL_MODE}" == "git_remote" ]]; then
  echo "Cloning ${APP_GIT_URL} into ${APP_DIR} as ${APP_USER}"
  su -s /bin/bash -c "git clone '${APP_GIT_URL}' '${APP_DIR}'" "${APP_USER}"
elif [[ "${INSTALL_MODE}" == "git_local" ]]; then
  echo "Cloning ${APP_REPO_SOURCE} into ${APP_DIR} as ${APP_USER}"
  su -s /bin/bash -c "git clone '${APP_REPO_SOURCE}' '${APP_DIR}'" "${APP_USER}"
  if [[ -n "${SOURCE_REMOTE_URL}" ]]; then
    su -s /bin/bash -c "git -C '${APP_DIR}' remote set-url origin '${SOURCE_REMOTE_URL}'" "${APP_USER}"
  fi
else
  echo "Syncing application files from ${APP_REPO_SOURCE}"
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
fi

if [[ -n "${APP_GIT_REF}" && "${INSTALL_MODE}" != "rsync" ]]; then
  su -s /bin/bash -c "git -C '${APP_DIR}' checkout '${APP_GIT_REF}'" "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/data"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/storage"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "Install failed: ${APP_DIR}/package.json was not copied."
  echo "Source used: ${INSTALL_SOURCE_LABEL}"
  exit 1
fi

if [[ ! -f "${APP_DIR}/package-lock.json" ]]; then
  echo "Install failed: ${APP_DIR}/package-lock.json was not copied."
  echo "Source used: ${INSTALL_SOURCE_LABEL}"
  exit 1
fi

echo "[6/9] Installing Node dependencies"
if su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev" "${APP_USER}"; then
  :
else
  echo "npm ci failed in ${APP_DIR}; falling back to npm install --omit=dev"
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
  "${APP_DIR}/deploy/ubuntu/synchro.service" >"/etc/systemd/system/${SERVICE_NAME}.service"

echo "[9/9] Installing nginx site template"
sed \
  -e "s|__DOMAIN_NAME__|${DOMAIN_NAME}|g" \
  -e "s|__APP_HOST__|${APP_HOST}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  "${APP_DIR}/deploy/ubuntu/nginx.synchro.conf" >"/etc/nginx/sites-available/${SERVICE_NAME}.conf"
ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}.conf" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
rm -f /etc/nginx/sites-enabled/default

if [[ ! -f "${APP_DIR}/.env" ]]; then
  install -o "${APP_USER}" -g "${APP_GROUP}" -m 0640 "${APP_DIR}/deploy/ubuntu/env.production.example" "${APP_DIR}/.env"
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
