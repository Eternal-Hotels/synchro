#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_SOURCE="$(cd "${SCRIPT_DIR}/../.." && pwd)"

APP_USER="${APP_USER:-synchro}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchro}"
APP_REPO_SOURCE="${APP_REPO_SOURCE:-${DEFAULT_REPO_SOURCE}}"
SERVICE_NAME="${SERVICE_NAME:-synchro}"

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

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "Update failed: ${APP_DIR}/package.json was not copied."
  echo "Source used: ${APP_REPO_SOURCE}"
  exit 1
fi

if [[ ! -f "${APP_DIR}/package-lock.json" ]]; then
  echo "Update failed: ${APP_DIR}/package-lock.json was not copied."
  echo "Source used: ${APP_REPO_SOURCE}"
  exit 1
fi

if su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev" "${APP_USER}"; then
  :
else
  echo "npm ci failed in ${APP_DIR}; falling back to npm install --omit=dev"
  su -s /bin/bash -c "cd '${APP_DIR}' && npm install --omit=dev" "${APP_USER}"
fi
su -s /bin/bash -c "'${APP_DIR}/.venv/bin/pip' install -r '${APP_DIR}/requirements-server.txt'" "${APP_USER}"

systemctl start "${SERVICE_NAME}"
systemctl --no-pager --full status "${SERVICE_NAME}"
