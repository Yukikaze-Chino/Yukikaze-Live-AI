import { AudioPlaybackGate } from "./audio-playback-gate.js";

export function outputLabel(output = {}) {
  if (!output || output.mode === "system") return "系统默认媒体输出";
  if (output.mode === "single") return output.primaryDeviceLabel || "单设备输出";
  if (output.mode === "dual") {
    const primary = output.primaryDeviceLabel || "主输出设备";
    const monitor = output.monitorDeviceLabel || "监听输出设备";
    return `${primary} + ${monitor}`;
  }
  return "未知输出模式";
}

function versionedAudioUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function defaultFetch(...args) {
  return globalThis.fetch(...args);
}

export class AudioPlaybackController {
  constructor({
    audioRouter,
    playbackGate = new AudioPlaybackGate(),
    fetchImpl = defaultFetch,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onState = () => {},
  } = {}) {
    this.audioRouter = audioRouter;
    this.playbackGate = playbackGate;
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.onState = onState;
    this.latestConfig = null;
    this.queue = [];
    this.handledIds = new Set();
    this.draining = null;
    this.pollTimer = null;
  }

  start({ intervalMilliseconds = 100 } = {}) {
    if (this.pollTimer) return;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), intervalMilliseconds);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    try {
      const response = await this.fetchImpl(`/api/state?t=${Date.now()}`);
      const data = await response.json();
      if (!data?.ok) return;
      this.latestConfig = data.config;
      this.onState({
        output: outputLabel(data.config?.audioOutput),
        line: data.audio?.text || "暂无",
      });
      this.receive(data.audio, data.config);
    } catch (error) {
      this.onState({ status: `连接失败：${error.message}` });
    }
  }

  receive(event, config = this.latestConfig) {
    if (!event?.shouldPlay || !String(event.audioUrl || "").trim()) {
      return { type: "ignore" };
    }
    if (this.handledIds.has(event.id)) return { type: "ignore" };
    this.handledIds.add(event.id);
    this.#trimHandledIds();

    if (!this.playbackGate.unlocked) {
      const action = this.playbackGate.receive(event);
      if (action.type === "pending") {
        this.onState({
          status: "收到语音，等待点击启用播放",
          output: outputLabel(config?.audioOutput),
          line: event.text || event.audioUrl,
        });
      }
      return action;
    }

    this.#enqueue(event, config);
    return { type: "queued" };
  }

  async unlock(config = this.latestConfig, { testAudioUrl = "" } = {}) {
    const pending = this.playbackGate.unlock();
    if (pending.type === "play") {
      this.#enqueue(pending.event, config);
      return this.whenIdle();
    }
    if (!testAudioUrl) {
      this.onState({ status: "已启用，等待雪风语音", output: outputLabel(config?.audioOutput) });
      return;
    }
    return this.playTest(config, testAudioUrl, "已启用，测试音已发送到输出设备");
  }

  async playTest(
    config = this.latestConfig,
    testAudioUrl = "/api/audio/test-tone",
    successMessage = "测试音已发送到输出设备",
  ) {
    try {
      await this.audioRouter.play(versionedAudioUrl(testAudioUrl), config?.audioOutput || { mode: "system" });
      this.onState({ status: successMessage, output: outputLabel(config?.audioOutput) });
    } catch (error) {
      this.onState({ status: `播放失败：${error.message}` });
      throw error;
    }
  }

  whenIdle() {
    return this.draining || Promise.resolve();
  }

  #enqueue(event, config) {
    this.queue.push({ event: { ...event }, config });
    if (!this.draining) {
      this.draining = this.#drain().finally(() => {
        this.draining = null;
        if (this.queue.length) this.#enqueueNextDrain();
      });
    }
  }

  #enqueueNextDrain() {
    if (this.draining) return;
    this.draining = this.#drain().finally(() => {
      this.draining = null;
      if (this.queue.length) this.#enqueueNextDrain();
    });
  }

  async #drain() {
    while (this.queue.length) {
      const { event, config } = this.queue.shift();
      this.onState({
        status: "正在播放",
        output: outputLabel(config?.audioOutput),
        line: event.text || event.audioUrl,
      });
      try {
        await this.audioRouter.play(
          versionedAudioUrl(event.audioUrl),
          config?.audioOutput || { mode: "system" },
        );
        const durationMilliseconds = Math.max(
          0,
          Number(event.audioDurationSeconds || 0) * 1000,
        );
        if (durationMilliseconds > 0) await this.wait(durationMilliseconds);
        this.playbackGate.markCompleted(event.id);
      } catch (error) {
        this.playbackGate.markFailed(event.id);
        this.onState({ status: `播放失败：${error.message}`, line: event.text || event.audioUrl });
      }
    }
    this.onState({ status: "等待语音" });
  }

  #trimHandledIds() {
    while (this.handledIds.size > 100) {
      this.handledIds.delete(this.handledIds.values().next().value);
    }
  }
}
