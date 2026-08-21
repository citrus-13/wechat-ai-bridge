#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${BRIDGE_PROJECT_DIR:-$(cd "${script_dir}/.." && pwd)}
bridge_user=${BRIDGE_USER:-${SUDO_USER:-ubuntu}}
compose_file="${project}/deploy/compose.yaml"
token_file="${project}/deploy/secrets/agent-wechat-token"

if ! id "${bridge_user}" >/dev/null 2>&1 || [[ "${bridge_user}" == root ]]; then
  echo "Set BRIDGE_USER to an existing non-root account." >&2
  exit 1
fi
test -f "${project}/package.json"
test -f "${project}/.env.cloud"
test -f "${compose_file}"
test -s "${token_file}"

chmod 0600 "${project}/.env.cloud" "${token_file}"
chown -R "${bridge_user}:${bridge_user}" \
  "${project}/deploy/secrets" \
  "${project}/deploy/codex-auth" \
  "${project}/deploy/cloud-data"

sudo -u "${bridge_user}" docker compose --env-file "${project}/.env.cloud" -f "${compose_file}" pull agent-wechat
sudo -u "${bridge_user}" docker compose --env-file "${project}/.env.cloud" -f "${compose_file}" build --pull wechat-ai-bridge
sudo -u "${bridge_user}" docker compose --env-file "${project}/.env.cloud" -f "${compose_file}" up -d
sudo -u "${bridge_user}" docker compose --env-file "${project}/.env.cloud" -f "${compose_file}" ps
