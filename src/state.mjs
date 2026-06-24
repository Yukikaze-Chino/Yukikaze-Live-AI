import {
  buildDanmakuText,
  buildGradioTtsArgs,
  createCaptionEvent,
} from "./core.mjs";

export function createLineJob(
  text,
  config,
  id = crypto.randomUUID(),
  overrides = {},
) {
  const normalizedText = String(text).trim();
  const source = overrides.source || "manual";
  return {
    id,
    text: normalizedText,
    danmakuText: buildDanmakuText(normalizedText, config.danmakuMaxLength),
    delaySeconds: config.ttsDelaySeconds,
    ttsArgs: buildGradioTtsArgs(normalizedText, config),
    publish: {
      enableTts: Boolean(overrides.enableTts ?? config.publish?.enableTts),
      enableCaption: Boolean(config.publish?.enableCaption),
      source,
    },
  };
}

export class CaptionStore {
  #sequence = 0;
  #current = {
    id: 0,
    text: "",
    visible: false,
    animation: "instant",
    durationSeconds: 0,
    fadeSeconds: 0.5,
    textBox: null,
  };

  publish(text, config, options = {}) {
    this.#sequence += 1;
    this.#current = createCaptionEvent(text, config, this.#sequence, options);
    return this.current();
  }

  clear(config) {
    this.#sequence += 1;
    this.#current = {
      ...createCaptionEvent("", config, this.#sequence),
      visible: false,
    };
    return this.current();
  }

  current() {
    return structuredClone(this.#current);
  }
}

export class CaptionAudioStore {
  #now;
  #sequence = 0;
  #current = {
    id: 0,
    jobId: "",
    text: "",
    audioUrl: "",
    audioDurationSeconds: 0,
    source: "",
    shouldPlay: false,
    expiresAt: "",
  };

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  publish({
    jobId,
    text,
    audioUrl,
    source = "ai",
    audioDurationSeconds = 0,
    playWindowSeconds = 30,
  }) {
    const normalizedUrl = String(audioUrl || "").trim();
    const windowMilliseconds = Math.max(
      1000,
      Number(playWindowSeconds || 30) * 1000,
    );
    this.#sequence += 1;
    this.#current = {
      id: this.#sequence,
      jobId: String(jobId || ""),
      text: String(text || ""),
      audioUrl: normalizedUrl,
      audioDurationSeconds: Math.max(0, Number(audioDurationSeconds || 0)),
      source: String(source || "ai"),
      shouldPlay: Boolean(normalizedUrl),
      expiresAt: normalizedUrl
        ? new Date(this.#now() + windowMilliseconds).toISOString()
        : "",
    };
    return this.current();
  }

  current() {
    const current = structuredClone(this.#current);
    if (
      current.shouldPlay &&
      current.expiresAt &&
      Date.parse(current.expiresAt) <= this.#now()
    ) {
      current.shouldPlay = false;
    }
    return current;
  }
}

export class DialogueLogStore {
  #limit;
  #entries = [];

  constructor({ limit = 5 } = {}) {
    this.#limit = Math.max(1, Math.trunc(Number(limit) || 5));
  }

  record({ id, text, source = "ai", createdAt = new Date().toISOString() }) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return this.current();
    this.#entries.push({
      id: String(id || crypto.randomUUID()),
      text: normalizedText,
      source: String(source || "ai"),
      createdAt: String(createdAt),
    });
    this.#entries = this.#entries.slice(-this.#limit);
    return this.current();
  }

  current({ limit = this.#limit } = {}) {
    const count = Math.max(1, Math.trunc(Number(limit) || this.#limit));
    return {
      entries: structuredClone(this.#entries.slice(-count)),
    };
  }
}
