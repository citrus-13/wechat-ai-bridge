import { execFile } from "node:child_process";

function execFileJson(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`desktop driver failed: ${stderr.trim() || error.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (parseError) {
        reject(new Error(`desktop driver returned invalid JSON: ${parseError.message}`));
      }
    });
  });
}

export class WeChatDesktopDriver {
  constructor(config) {
    this.config = config;
  }

  run(command, extra = []) {
    const desktop = this.config.wechat.desktop;
    return execFileJson(desktop.python, [desktop.driverPath, command, ...extra], {
      env: {
        ...process.env,
        DISPLAY: desktop.display,
        WECHAT_WINDOW_TITLE: desktop.windowTitle,
        WECHAT_TARGET_GROUP: desktop.targetGroup,
        WECHAT_AI_NAME: desktop.aiName,
        WECHAT_ALLOWED_SENDERS: desktop.allowedSenders.join(","),
        WECHAT_UI_STATE: desktop.statePath,
        WECHAT_UI_SCREENSHOT: desktop.screenshotPath,
      },
      timeout: command === "poll" ? 30_000 : 20_000,
    });
  }

  check() {
    return this.run("check");
  }

  poll() {
    return this.run("poll");
  }

  send(text) {
    return this.run("send", [Buffer.from(text, "utf8").toString("base64")]);
  }
}
