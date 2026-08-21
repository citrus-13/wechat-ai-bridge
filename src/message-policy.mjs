function normalized(value) {
  return String(value || "").replace(/\u00a0/g, " ").trim();
}

function triggerPattern(aiName) {
  const escaped = aiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[@＠]\\s*${escaped}(?:\\u2005|(?=\\s|[，,。.!！?？:：]|$))`, "giu");
}

export class MessagePolicy {
  constructor(options, clock = () => Date.now()) {
    this.targetGroup = normalized(options.targetGroup);
    this.aiName = normalized(options.aiName);
    this.allowedSenders = new Set((options.allowedSenders || []).map(normalized));
    this.maxRepliesPerMinute = options.maxRepliesPerMinute;
    this.senderCooldownMs = options.senderCooldownSeconds * 1000;
    this.maxMessageChars = options.maxMessageChars;
    this.clock = clock;
    this.globalReplyTimes = [];
    this.senderLastReply = new Map();
  }

  evaluate(event) {
    const now = this.clock();
    const chatType = event.chatType === "direct" ? "direct" : "group";
    const replyMode = chatType === "direct" ? "all" : String(event.replyMode || "mention-only");
    const group = normalized(event.group);
    const sender = normalized(event.sender);
    const rawText = normalized(event.text);
    if (chatType === "group" && this.targetGroup && group !== this.targetGroup) {
      return { accepted: false, reason: "wrong-group" };
    }
    if (replyMode === "disabled") return { accepted: false, reason: "chat-disabled" };
    if (replyMode !== "all" && replyMode !== "mention-only") {
      return { accepted: false, reason: "invalid-reply-mode" };
    }
    if (event.isSelf === true) return { accepted: false, reason: "self-message" };
    if (!sender) return { accepted: false, reason: "empty-sender" };
    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(sender)) {
      return { accepted: false, reason: "sender-not-allowed" };
    }
    if (!rawText) return { accepted: false, reason: "empty" };
    if (chatType === "group" && replyMode === "mention-only") {
      // agent-wechat derives this from WeChat's native atuserlist metadata. A
      // visually typed "@AI" string is deliberately insufficient to send.
      if (event.isMentioned !== true) return { accepted: false, reason: "not-mentioned" };
      // Require the visible mention to name this account as well. This protects
      // against stale native metadata and display-name changes.
      if (!this.aiName || !triggerPattern(this.aiName).test(rawText)) {
        return { accepted: false, reason: "mention-name-mismatch" };
      }
    }
    const hasVisibleMention = this.aiName && triggerPattern(this.aiName).test(rawText);
    const text = (hasVisibleMention ? rawText.replace(triggerPattern(this.aiName), " ") : rawText)
      .replace(/^\s*[，,。.!！?？:：;；、-]+\s*/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return { accepted: false, reason: "empty-question" };
    if (text.length > this.maxMessageChars) return { accepted: false, reason: "too-long" };

    this.globalReplyTimes = this.globalReplyTimes.filter((time) => now - time < 60_000);
    if (this.globalReplyTimes.length >= this.maxRepliesPerMinute) {
      return { accepted: false, reason: "global-rate-limit" };
    }
    const senderKey = normalized(event.senderKey) || sender;
    const senderLast = this.senderLastReply.get(senderKey) || 0;
    if (now - senderLast < this.senderCooldownMs) return { accepted: false, reason: "sender-cooldown" };
    return { accepted: true, sender, senderKey, text };
  }

  recordReply(sender) {
    const now = this.clock();
    this.globalReplyTimes.push(now);
    this.senderLastReply.set(normalized(sender), now);
  }
}
