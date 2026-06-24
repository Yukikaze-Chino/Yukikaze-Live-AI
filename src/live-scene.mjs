const HUMAN_INTERACTION_KINDS = new Set([
  "danmaku",
  "room_enter",
  "follow",
  "gift",
  "share",
  "guard",
  "super_chat",
  "like",
]);

export class LiveSceneState {
  constructor({ now = () => Date.now(), random = Math.random } = {}) {
    this.now = now;
    this.random = random;
    this.lastInteractionAt = null;
    this.nextIdleCheckAt = null;
    this.screenReadTimes = [];
    this.visionVerified = false;
    this.lastScreenSummary = "";
    this.lastScreenSummaryAt = null;
    this.lastScreenDisplayId = "";
    this.lastError = "";
  }

  noteInteraction(event) {
    if (!HUMAN_INTERACTION_KINDS.has(String(event?.kind || ""))) {
      return false;
    }

    this.lastInteractionAt = this.now();
    this.nextIdleCheckAt = null;
    return true;
  }

  takeIdleCheck({ config, queue }) {
    const scene = config?.ai?.scene;
    if (!scene?.enabled || this.lastInteractionAt === null) return null;

    const queueStatus = queue?.status?.() || {};
    if (queueStatus.busy || Number(queueStatus.queuedSegments || 0) > 0) {
      return null;
    }

    const now = this.now();
    if (now - this.lastInteractionAt < scene.idleMinSeconds * 1000) {
      return null;
    }
    if (this.nextIdleCheckAt !== null && now < this.nextIdleCheckAt) {
      return null;
    }

    const minimum = scene.idleCooldownMinSeconds;
    const maximum = scene.idleCooldownMaxSeconds;
    const cooldownSeconds = Math.min(
      maximum,
      minimum + Math.floor(this.random() * (maximum - minimum + 1)),
    );
    this.nextIdleCheckAt = now + cooldownSeconds * 1000;
    return {
      kind: "idle_check",
      source: "live-scene",
      receivedAt: toIso(now),
    };
  }

  requestScreenRead({ config }) {
    const vision = config?.ai?.scene?.vision;
    if (!vision?.enabled) {
      this.lastError = "屏幕理解未启用。";
      return null;
    }
    if (!vision.displayId) {
      this.lastError = "尚未选择显示器。";
      return null;
    }
    if (!this.visionVerified) {
      this.lastError = "当前模型的图像输入尚未验证。";
      return null;
    }

    const now = this.now();
    const windowStart = now - vision.rollingWindowSeconds * 1000;
    this.screenReadTimes = this.screenReadTimes.filter(
      (timestamp) => timestamp >= windowStart,
    );
    if (this.screenReadTimes.length >= vision.maxCapturesPerWindow) {
      this.lastError = "屏幕理解已达到滚动时间窗口上限。";
      return null;
    }

    this.screenReadTimes.push(now);
    this.lastError = "";
    return {
      displayId: vision.displayId,
      requestedAt: toIso(now),
    };
  }

  recordScreenSummary({ summary, displayId }) {
    const text = typeof summary === "string" ? summary.trim() : "";
    if (!text || looksLikeRawScreenData(text)) {
      this.lastError = "屏幕摘要必须是普通文本，不能保存图像或文件路径。";
      return false;
    }

    this.lastScreenSummary = text;
    this.lastScreenSummaryAt = this.now();
    this.lastScreenDisplayId = String(displayId || "").trim();
    this.lastError = "";
    return true;
  }

  setVisionVerified(verified) {
    this.visionVerified = Boolean(verified);
  }

  status() {
    const now = this.now();
    return {
      silenceSeconds:
        this.lastInteractionAt === null
          ? null
          : Math.max(0, Math.floor((now - this.lastInteractionAt) / 1000)),
      lastInteractionAt: toIso(this.lastInteractionAt),
      nextIdleCheckAt: toIso(this.nextIdleCheckAt),
      lastError: this.lastError,
      vision: {
        verified: this.visionVerified,
        usedCaptures: this.screenReadTimes.length,
        lastSummary: this.lastScreenSummary,
        lastSummaryAt: toIso(this.lastScreenSummaryAt),
        lastDisplayId: this.lastScreenDisplayId,
      },
    };
  }
}

function looksLikeRawScreenData(text) {
  return (
    /^data:/i.test(text) ||
    /^file:/i.test(text) ||
    /^[a-z]:[\\/]/i.test(text) ||
    /^\\\\/.test(text)
  );
}

function toIso(timestamp) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}
