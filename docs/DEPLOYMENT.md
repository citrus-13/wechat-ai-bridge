# Deployment guide

This guide describes the supported split deployment: the cloud host keeps the dedicated WeChat account online, while the Mac supplies local Qwen whenever it is awake. Codex can provide the Mac-off fallback after an explicit ChatGPT sign-in.

## 1. Prepare the Mac

Install Node.js 22+, Docker Desktop or Colima, and Ollama. Then:

```bash
git clone https://github.com/citrus-13/wechat-ai-bridge.git
cd wechat-ai-bridge
npm ci
npm run init
ollama pull qwen3.5:9b-mlx
bash deploy/start-agent-wechat-local.sh
```

Open `http://127.0.0.1:6174/vnc/` and sign the dedicated WeChat account into the local test container. Do not make port 6174 externally reachable.

If Codex fallback is wanted on the Mac, use ChatGPT sign-in and confirm the method:

```bash
npm run prepare-local-codex
npx codex login
npx codex login status
npm run doctor
```

Install the local services only after `doctor` and the tests pass:

```bash
npm test
bash deploy/install-mac-local.sh
```

## 2. Prepare a Linux host

Use Ubuntu 24.04 on `aarch64` or `x86_64`. Size the host for the external WeChat desktop runtime as well as Docker; very small instances may be unstable even when swap is available.

Copy or clone the repository to a non-root account. Copy the two generated values from the private Mac `.env` into a new `.env.cloud` based on `.env.cloud.example`:

```bash
cp .env.cloud.example .env.cloud
chmod 600 .env.cloud
```

Do not copy the whole Mac `.env`, OAuth directory, SSH private key, or chat database.

Bootstrap with SSH restricted to the administrator's public source CIDR:

```bash
sudo SSH_ALLOWED_CIDR="203.0.113.10/32" \
  BRIDGE_USER="$USER" \
  ./deploy/bootstrap-ubuntu.sh
```

Replace the documentation-only CIDR with the real administrator source. Re-login once so Docker group membership takes effect, then install:

```bash
sudo BRIDGE_USER="$USER" ./deploy/install-cloud-services.sh
```

The scripts create private `deploy/secrets`, `deploy/codex-auth`, and `deploy/cloud-data` directories. They do not open the WeChat/VNC or bridge ports in UFW.

## 3. Authorize Codex on the host

Run device authorization in a one-off bridge container:

```bash
docker compose --env-file .env.cloud -f deploy/compose.yaml run --rm --no-deps \
  wechat-ai-bridge codex login --device-auth

docker compose --env-file .env.cloud -f deploy/compose.yaml run --rm --no-deps \
  wechat-ai-bridge codex login status
```

Open the displayed verification URL on a trusted device and complete the ChatGPT authorization. The resulting cached credentials remain in `deploy/codex-auth` and survive normal container restarts. Treat that directory like a password; never commit or copy it into an image.

Restart the bridge after successful authorization:

```bash
docker compose --env-file .env.cloud -f deploy/compose.yaml restart wechat-ai-bridge
```

## 4. Sign WeChat in on the host

From the Mac, first verify the cloud host's SSH fingerprint. Then create a temporary local forward:

```bash
ssh -NT -L 6174:127.0.0.1:6174 user@cloud.example
```

Open `http://127.0.0.1:6174/vnc/`, enter the cloud host's `deploy/secrets/agent-wechat-token`, and sign in with the dedicated account. Close the temporary tunnel after login.

Persistent container volumes retain the login state across ordinary restarts. A WeChat security challenge, client update, token rotation, data-volume removal, or account-side logout can still require another login.

## 5. Switch the Mac to cloud-held WeChat

Create a dedicated SSH key and authorize only its public half on the cloud host. Connect once manually and verify the fingerprint so it is present in `known_hosts`. Then:

```bash
WECHAT_AI_SSH_USER=user \
  bash deploy/switch-mac-to-cloud.sh cloud.example "$HOME/.ssh/wechat_ai_bridge"
```

The LaunchAgent creates:

- a local forward from Mac `43111` to cloud `43111` for encrypted sync;
- a reverse forward from cloud `43110` to Mac `43110` for local Qwen.

When the Mac sleeps or disconnects, the reverse forward disappears and the bridge uses the configured Codex fallback. When the Mac reconnects, local Qwen becomes the preferred route again.

## 6. Configure reply policies

Edit `.env.cloud`, keeping group IDs exact and comma-separated:

```dotenv
WECHAT_DM_POLICY=open
WECHAT_GROUP_DEFAULT_MODE=mention-only
WECHAT_GROUP_ALL_REPLY_CHAT_IDS=
WECHAT_GROUP_MENTION_ONLY_CHAT_IDS=
WECHAT_GROUP_DISABLED_CHAT_IDS=
WECHAT_ALLOWED_SENDERS=
```

For an exact group lookup while the loopback API is reachable:

```bash
npm run configure:group -- "Exact group name" "AI display name"
```

Restart after configuration changes:

```bash
docker compose --env-file .env.cloud -f deploy/compose.yaml up -d
```

## 7. Operations

```bash
docker compose --env-file .env.cloud -f deploy/compose.yaml ps
docker compose --env-file .env.cloud -f deploy/compose.yaml logs --tail=100 wechat-ai-bridge
touch deploy/cloud-data/PAUSE
rm deploy/cloud-data/PAUSE
```

Creating `PAUSE` stops new replies while leaving processes and login state intact. Removing it resumes polling.

Back up only encrypted/necessary state, keep backups private, and test restoration. Do not put any backup into the source repository.

## Updating

Before updating, read release notes and retain a private backup of the data volumes and configuration. Then:

```bash
git pull --ff-only
npm ci
npm run check
sudo BRIDGE_USER="$USER" ./deploy/install-cloud-services.sh
```

The external WeChat image is pinned by digest. Change `AGENT_WECHAT_IMAGE` only after reviewing the replacement image, supported architecture, upstream changes, and license status.
