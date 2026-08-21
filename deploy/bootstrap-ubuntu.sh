#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|x86_64) ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${BRIDGE_PROJECT_DIR:-$(cd "${script_dir}/.." && pwd)}
bridge_user=${BRIDGE_USER:-${SUDO_USER:-ubuntu}}
if ! id "${bridge_user}" >/dev/null 2>&1 || [[ "${bridge_user}" == root ]]; then
  echo "Set BRIDGE_USER to an existing non-root account." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl docker.io docker-compose-v2 jq openssl ufw

memory_kib=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
if (( memory_kib < 2097152 )) && ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi

systemctl enable --now docker
usermod -aG docker "${bridge_user}"

install -d -m 0700 -o "${bridge_user}" -g "${bridge_user}" \
  "${project}/deploy/secrets" \
  "${project}/deploy/codex-auth" \
  "${project}/deploy/cloud-data"
token_file="${project}/deploy/secrets/agent-wechat-token"
if [[ ! -s "${token_file}" ]]; then
  umask 077
  openssl rand -hex 32 > "${token_file}"
fi
chown "${bridge_user}:${bridge_user}" "${token_file}"
chmod 0600 "${token_file}"

ufw default deny incoming
ufw default allow outgoing
if [[ -n "${SSH_ALLOWED_CIDR:-}" ]]; then
  ufw allow from "${SSH_ALLOWED_CIDR}" to any port 22 proto tcp
else
  echo "WARNING: SSH_ALLOWED_CIDR is unset; SSH will be allowed from any source." >&2
  ufw allow OpenSSH
fi
ufw --force enable

echo "Bootstrap complete for ${bridge_user}. Re-login for Docker group access, then run deploy/install-cloud-services.sh."
