#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-synchro}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchro}"
APP_REPO_SOURCE="${APP_REPO_SOURCE:-}"
SERVICE_NAME="${SERVICE_NAME:-synchro}"

if [[ -z "${APP_REPO_SOURCE}" ]]; then
  echo "Set APP_REPO_SOURCE to the checked-out repo you want to deploy from."
  exit 1
fi

if [[ ! -d "${APP_REPO_SOURCE}" ]]; then
  echo "APP_REPO_SOURCE does not exist: ${APP_REPO_SOURCE}"
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo APP_REPO_SOURCE=/path/to/repo bash deploy/ubuntu/update-app.sh"
  exit 1
fi

systemctl stop "${SERVICE_NAME}"

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

su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev" "${APP_USER}"
su -s /bin/bash -c "'${APP_DIR}/.venv/bin/pip' install -r '${APP_DIR}/requirements-server.txt'" "${APP_USER}"

systemctl start "${SERVICE_NAME}"
systemctl --no-pager --full status "${SERVICE_NAME}"
