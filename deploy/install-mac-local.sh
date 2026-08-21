#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${1:-$(cd "${script_dir}/.." && pwd)}
data_dir=${2:-${BRIDGE_DATA_DIR:-${HOME}/Library/Application Support/WeChatAIBridge}}
runtime="${data_dir}/runtime"
env_file="${data_dir}/bridge.env"
launch_agents="${HOME}/Library/LaunchAgents"
template="${project}/deploy/macos-service.plist.template"
node_bin=$(command -v node)

test -d "${project}/src"
test -d "${project}/node_modules"
test -f "${project}/package.json"
test -f "${env_file}"
test -f "${template}"
test -n "${node_bin}"

mkdir -p "${runtime}" "${launch_agents}"
ditto "${project}/src" "${runtime}/src"
ditto "${project}/node_modules" "${runtime}/node_modules"
cp "${project}/package.json" "${project}/package-lock.json" "${runtime}/"
chmod -R go-rwx "${runtime}"
chmod 0600 "${env_file}"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

render_service() {
  local label=$1
  local command=$2
  local log_name=$3
  local destination="${launch_agents}/${label}.plist"
  local temp_file
  temp_file=$(mktemp)
  sed \
    -e "s|__LABEL__|$(escape_sed "${label}")|g" \
    -e "s|__NODE__|$(escape_sed "${node_bin}")|g" \
    -e "s|__ENV_FILE__|$(escape_sed "${env_file}")|g" \
    -e "s|__RUNTIME__|$(escape_sed "${runtime}")|g" \
    -e "s|__COMMAND__|$(escape_sed "${command}")|g" \
    -e "s|__LOG_NAME__|$(escape_sed "${log_name}")|g" \
    -e "s|__DATA__|$(escape_sed "${data_dir}")|g" \
    "${template}" > "${temp_file}"
  plutil -lint "${temp_file}"
  launchctl bootout "gui/$(id -u)" "${destination}" 2>/dev/null || true
  install -m 0644 "${temp_file}" "${destination}"
  launchctl bootstrap "gui/$(id -u)" "${destination}"
  launchctl kickstart -k "gui/$(id -u)/${label}"
  rm -f "${temp_file}"
}

render_service "io.github.wechat-ai-bridge.local" "local" "local"
render_service "io.github.wechat-ai-bridge.agent" "cloud" "agent"

echo "Installed localhost services from ${runtime}."
