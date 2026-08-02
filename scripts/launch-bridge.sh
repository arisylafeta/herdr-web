#!/usr/bin/env bash
# launchd entrypoint: load the same plugin environment as collie-ctl, then pin the launcher's
# validated socket/port/public-host values before starting the long-lived bridge process.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:?missing HERDR_PLUGIN_CONFIG_DIR}"
if [ -f "${CONFIG_DIR}/.env" ]; then
  set -a
  . "${CONFIG_DIR}/.env"
  set +a
fi

export HERDR_SOCKET_PATH="${HERDR_CONTROL_SOCKET_PATH:?missing HERDR_CONTROL_SOCKET_PATH}"
export COLLIE_PORT="${HERDR_CONTROL_EFFECTIVE_PORT:?missing HERDR_CONTROL_EFFECTIVE_PORT}"
export COLLIE_PUBLIC_HOSTS="${HERDR_CONTROL_PUBLIC_HOSTS:-}"
export HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS="$COLLIE_PUBLIC_HOSTS"
exec "${HERDR_CONTROL_BUN:?missing HERDR_CONTROL_BUN}" run "${PLUGIN_ROOT}/bridge/index.ts"
