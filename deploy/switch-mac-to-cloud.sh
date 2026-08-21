#!/usr/bin/env bash
set -euo pipefail

cloud_host=${1:-}
ssh_key=${2:-${WECHAT_AI_SSH_KEY:-${HOME}/.ssh/wechat_ai_bridge}}
ssh_user=${WECHAT_AI_SSH_USER:-ubuntu}
if [[ -z "${cloud_host}" || "${cloud_host}" == -* || "${cloud_host}" =~ [^A-Za-z0-9.:-] ]]; then
  echo "Usage: $0 <cloud-ip-or-hostname> [ssh-private-key]" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=$(cd "${script_dir}/.." && pwd)
data_dir=${BRIDGE_DATA_DIR:-${HOME}/Library/Application Support/WeChatAIBridge}
template="${project}/deploy/macos-tunnel.plist.template"
launch_agents="${HOME}/Library/LaunchAgents"
plist="${launch_agents}/io.github.wechat-ai-bridge.tunnel.plist"
agent_plist="${launch_agents}/io.github.wechat-ai-bridge.agent.plist"

test -f "${template}"
test -f "${ssh_key}"
if ! ssh-keygen -F "${cloud_host}" >/dev/null; then
  echo "Cloud host key is not trusted yet. Connect once and verify its fingerprint first." >&2
  exit 1
fi

escape_sed() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

mkdir -p "${launch_agents}" "${data_dir}"
tmp_plist=$(mktemp)
trap 'rm -f "${tmp_plist}"' EXIT
sed \
  -e "s|__CLOUD_HOST__|$(escape_sed "${cloud_host}")|g" \
  -e "s|__SSH_USER__|$(escape_sed "${ssh_user}")|g" \
  -e "s|__SSH_KEY__|$(escape_sed "${ssh_key}")|g" \
  -e "s|__DATA__|$(escape_sed "${data_dir}")|g" \
  "${template}" > "${tmp_plist}"
plutil -lint "${tmp_plist}"
install -m 0644 "${tmp_plist}" "${plist}"

# The cloud client becomes the sole WeChat reader. The Mac keeps Qwen,
# encrypted local memory, and the SSH bridge used whenever the Mac is awake.
launchctl bootout "gui/$(id -u)" "${agent_plist}" 2>/dev/null || true
if docker container inspect agent-wechat-local >/dev/null 2>&1; then
  docker update --restart=no agent-wechat-local >/dev/null
  docker stop agent-wechat-local >/dev/null || true
fi
launchctl bootout "gui/$(id -u)" "${plist}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${plist}"
launchctl kickstart -k "gui/$(id -u)/io.github.wechat-ai-bridge.tunnel"

echo "Cloud routing enabled; the Mac Qwen route will reconnect through SSH when this Mac is online."
