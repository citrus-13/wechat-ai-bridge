#!/usr/bin/env bash
set -euo pipefail

IMAGE="${AGENT_WECHAT_IMAGE:-ghcr.io/thisnick/agent-wechat@sha256:31a4e351c191bcbfc75e5c10be51e207d22a3eedd97f3ff56ad579fcce717b24}"
BRIDGE_DATA_DIR="${BRIDGE_DATA_DIR:-${HOME}/Library/Application Support/WeChatAIBridge}"
TOKEN_FILE="${BRIDGE_DATA_DIR}/agent-wechat-token"

if [[ ! -s "${TOKEN_FILE}" ]]; then
  echo "Missing ${TOKEN_FILE}; run npm run init first." >&2
  exit 1
fi

if docker container inspect agent-wechat-local >/dev/null 2>&1; then
  docker start agent-wechat-local >/dev/null
else
  docker run -d \
    --name agent-wechat-local \
    --restart unless-stopped \
    --security-opt seccomp=unconfined \
    --cap-add SYS_PTRACE \
    -p 127.0.0.1:6174:6174 \
    -v agent-wechat-local-data:/data \
    -v agent-wechat-local-home:/home/wechat \
    -v "${TOKEN_FILE}:/data/auth-token:ro" \
    "${IMAGE}" >/dev/null
fi

echo "agent-wechat-local is starting at http://127.0.0.1:6174/vnc/"
