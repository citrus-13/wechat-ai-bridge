# 微信 AI 桥接工具

[English](../README.md) · [架构](ARCHITECTURE.md) · [部署](DEPLOYMENT.md) · [安全](../SECURITY.md)

这是一个实验性的自托管工具：让一个专用个人微信账号自动回复消息，同时不在服务中放置 OpenAI API Key。

- 所有真实联系人私聊可自动回复。
- 新加入的群自动继承安全默认值：只有原生 `@` 到机器人时才回复。
- 指定群可覆盖为全部回复、仅被提及时回复或完全停用。
- Mac 在线时优先走本地 Ollama/Qwen。
- Mac 离线时可使用已通过 ChatGPT 登录的官方 Codex CLI 作为备用线路。
- 提醒任务可跨重启恢复，云端同步到 Mac 的记录经过加密。

> [!WARNING]
> 这不是微信或 OpenAI 官方集成。桌面客户端自动化可能随微信升级失效，也可能触发账号限制。务必使用专用次要微信号、不要公开任何服务端口，并先用少量联系人测试。

## 架构

```text
私有容器里的 Linux 微信
          │ 本机回环 API
          ▼
    WeChat AI Bridge
       │         │
 Mac 在线       Mac 离线
       ▼         ▼
 本地 Qwen    Codex CLI
  (Ollama)   (ChatGPT 登录)
       │         │
       └── 回复策略 ──► 微信
```

云主机与 Mac 只通过 SSH 隧道连接，微信 API、noVNC 和同步 API 默认都只监听 `127.0.0.1`。完整数据流和信任边界见[架构说明](ARCHITECTURE.md)。

## 默认策略

| 范围 | 默认设置 |
| --- | --- |
| 私聊 | 自动回复，公众号和系统会话除外 |
| 新群 | `mention-only` |
| 逐群覆盖 | 使用不可变 `...@chatroom` ID |
| 发送者白名单 | 留空代表所有联系人/成员 |
| 远端上下文 | 只上传当前触发消息 |
| Codex 权限 | 临时会话、只读沙箱、无 Shell/浏览器/插件 |
| 服务端口 | 仅回环地址 |
| 急停 | 创建配置中的 `PAUSE` 文件 |

任何群 ID、原生 `@` 状态、发送者、登录状态或发送框无法确认时，程序都会失败即不发送。

## Mac 快速开始

准备 Node.js 22+、Docker/Colima 和 Ollama，然后运行：

```bash
git clone https://github.com/citrus-13/wechat-ai-bridge.git
cd wechat-ai-bridge
npm ci
npm run init
ollama pull qwen3.5:9b-mlx
bash deploy/start-agent-wechat-local.sh
```

打开 `http://127.0.0.1:6174/vnc/`，输入保存在 `~/Library/Application Support/WeChatAIBridge/agent-wechat-token` 的令牌，再用专用微信账号登录。

可选：准备 Codex 备用线路并检查环境：

```bash
npm run prepare-local-codex
npx codex login
npm run doctor
npm test
```

检查通过后安装 Mac 后台服务：

```bash
bash deploy/install-mac-local.sh
```

Linux 云主机、扫码隧道和常驻部署见[部署指南](DEPLOYMENT.md)。正常重启会保留微信登录数据；不要为了“刷新”随意删除容器卷或轮换令牌，否则可能要求重新登录。

## 私聊和群聊配置

```dotenv
WECHAT_DM_POLICY=open
WECHAT_GROUP_DEFAULT_MODE=mention-only
WECHAT_GROUP_ALL_REPLY_CHAT_IDS=
WECHAT_GROUP_MENTION_ONLY_CHAT_IDS=
WECHAT_GROUP_DISABLED_CHAT_IDS=
WECHAT_ALLOWED_SENDERS=
```

- 私聊 `open` 会回复真实联系人，不触发公众号、文件传输助手等服务会话。
- `mention-only` 同时要求微信原生提及元数据和正文中的机器人显示名，手工输入看起来像 `@AI` 的文字不算。
- `all` 对该群的普通消息也回复。
- `disabled` 不回复，并持续推进游标，重新启用时不会补发旧消息。
- 新发现的群自动继承 `WECHAT_GROUP_DEFAULT_MODE`，不用逐个找维护者配置。
- 三个群 ID 覆盖列表必须互斥，冲突时程序拒绝启动。

每个私聊和群都有独立的哈希会话范围。第一次发现会话只处理未读尾部，不会把全部历史补发给模型。

## 模型路由

Mac 路线正常时，普通消息始终优先本地 Qwen。Mac 离线并进入 Codex 备用线路后，可用前缀选择档位：

```text
/luna 快速回答
/terra 深度比较这几个方案
/sol 用最高强度分析这项长期决策
```

模型别名和使用权限取决于当前 Codex 版本及登录账号，配置中的名称不构成长期兼容承诺。

## 费用与账号说明

公开版不配置 OpenAI API、Vercel AI Gateway 或 GitHub Models 凭据。备用线路通过 `codex login` 使用 ChatGPT 登录，但 ChatGPT 订阅不等于“免费或无限”：可用功能、额度和使用条款仍取决于你的套餐。请阅读官方 [Codex 登录说明](https://developers.openai.com/codex/auth)，并自行确认这种自托管方式符合账号条款。

本项目不提供托管服务，也无法替你承担或查看云服务器、ChatGPT、网络和电费。

## 隐私与风险

- `.env`、OAuth 状态、Token、SSH 私钥、聊天数据库、截图和云端数据均被 Git 忽略，并在打包前扫描。
- 默认 `CLOUD_ALLOW_REMOTE_CONTEXT=false`，Codex 只接收当前触发消息。
- Codex 使用临时会话、只读沙箱、禁止审批，并关闭非必要工具能力。
- 云端同步队列和待发提醒使用 AES-256-GCM 加密；Mac 确认导入后删除相应队列记录。
- 微信容器仍会保存客户端登录状态和消息数据；磁盘加密不等于端到端加密。
- 第三方 `agent-wechat` 镜像不是本仓库代码，授权状态和兼容性需使用者自行复核，详见[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 开发验证

```bash
npm ci
npm run check
npm audit --omit=dev
npm pack --dry-run
```

自有桥接代码采用 [MIT License](../LICENSE)。微信、模型、第三方运行时和商标均遵循各自条款。本项目与腾讯、微信、OpenAI、阿里巴巴、Ollama 及 `agent-wechat` 维护者无隶属关系。
