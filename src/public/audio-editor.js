import WaveSurfer from "/public/vendor/wavesurfer.esm.js";
import RegionsPlugin from "/public/vendor/regions.esm.js";

export class ReferenceAudioEditor {
  constructor({
    api,
    log,
    getConfig,
    saveConfig,
    refreshResources,
  }) {
    this.api = api;
    this.log = log;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.refreshResources = refreshResources;
    this.resources = [];
    this.currentAudio = null;
    this.region = null;
    this.suppressRegionUpdate = false;

    this.select = document.querySelector("#referenceSelect");
    this.detail = document.querySelector("#referenceDetail");
    this.loading = document.querySelector("#waveLoading");
    this.startInput = document.querySelector("#trimStart");
    this.endInput = document.querySelector("#trimEnd");
    this.durationNode = document.querySelector("#trimDuration");
    this.validationNode = document.querySelector("#trimValidation");
    this.promptInput = document.querySelector("#referencePrompt");
    this.languageSelect = document.querySelector("#referenceLanguage");
    this.trimButton = document.querySelector("#trimReferenceButton");
    this.useButton = document.querySelector("#useReferenceButton");

    this.regions = RegionsPlugin.create();
    this.waveSurfer = WaveSurfer.create({
      container: "#waveform",
      waveColor: "#8895ae",
      progressColor: "#ff5aa2",
      cursorColor: "#f7d5e4",
      height: 140,
      normalize: true,
      minPxPerSec: 80,
      plugins: [this.regions],
    });

    this.#bindEvents();
  }

  setResources(resources) {
    const previousName = this.select.value;
    this.resources = resources || [];
    this.select.replaceChildren();
    for (const item of this.resources) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      option.selected =
        item.name === previousName ||
        (!previousName && item.selected);
      this.select.append(option);
    }
    if (!this.select.value && this.resources.length > 0) {
      this.select.value = this.resources[0].name;
    }
  }

  async loadSelected() {
    const name = this.select.value;
    if (!name) return;
    this.loading.textContent = "正在读取波形…";
    this.loading.classList.remove("hidden");
    const data = await this.api(
      `/api/audio/metadata?name=${encodeURIComponent(name)}`,
    );
    this.currentAudio = data;
    const item = this.resources.find((entry) => entry.name === name);
    this.detail.textContent = item
      ? `${this.#formatBytes(item.size)} · ${new Date(
          item.modifiedAt,
        ).toLocaleString()} · 原始时长 ${data.audio.durationSeconds.toFixed(2)} 秒`
      : `原始时长 ${data.audio.durationSeconds.toFixed(2)} 秒`;

    const metadata = data.metadata || {};
    const config = this.getConfig();
    this.promptInput.value =
      metadata.promptText ?? config.tts.promptText ?? "";
    this.languageSelect.value =
      metadata.promptLang || config.tts.promptLang || "ja";

    await this.waveSurfer.load(`${data.audioUrl}?t=${Date.now()}`);
  }

  async applyCurrentReference() {
    if (!this.currentAudio) return;
    const fullDuration = this.currentAudio.audio.durationSeconds;
    if (fullDuration < 3 || fullDuration > 10) {
      throw new Error(
        `当前完整音频为 ${fullDuration.toFixed(
          2,
        )} 秒，必须先裁剪为 3～10 秒。`,
      );
    }
    const name = this.select.value;
    await this.api("/api/audio/metadata", {
      method: "PUT",
      body: JSON.stringify({
        name,
        promptText: this.promptInput.value,
        promptLang: this.languageSelect.value,
      }),
    });
    const selected = this.resources.find((item) => item.name === name);
    await this.saveConfig({
      tts: {
        refAudioPath: selected.path,
        promptText: this.promptInput.value,
        promptLang: this.languageSelect.value,
      },
    });
    this.log(`已使用参考音频：${name}`);
  }

  async trimAndApply() {
    if (!this.currentAudio || !this.region) return;
    const validation = this.#validation();
    if (!validation.ok) throw new Error(validation.message);
    const data = await this.api("/api/audio/trim", {
      method: "POST",
      body: JSON.stringify({
        sourceName: this.select.value,
        startSeconds: this.region.start,
        endSeconds: this.region.end,
        promptText: this.promptInput.value,
        promptLang: this.languageSelect.value,
      }),
    });
    await this.refreshResources();
    this.select.value = data.result.name;
    await this.loadSelected();
    this.log(`裁剪并启用参考音频：${data.result.name}`);
  }

  #bindEvents() {
    this.waveSurfer.on("ready", () => {
      this.loading.classList.add("hidden");
      const duration = this.waveSurfer.getDuration();
      const metadata = this.currentAudio?.metadata;
      const start = Math.max(0, Number(metadata?.trimStart || 0));
      const end = Math.min(
        duration,
        Number(metadata?.trimEnd || Math.min(duration, 10)),
      );
      this.#setRegion(start, end);
    });

    this.regions.on("region-updated", (region) => {
      if (this.suppressRegionUpdate) return;
      this.region = region;
      this.#syncInputsFromRegion();
    });

    this.regions.on("region-out", (region) => {
      if (region === this.region) this.waveSurfer.pause();
    });

    this.select.addEventListener("change", () => {
      this.loadSelected().catch((error) => this.log(error.message));
    });
    document
      .querySelector("#playOriginalButton")
      .addEventListener("click", () => this.waveSurfer.playPause());
    document
      .querySelector("#playSelectionButton")
      .addEventListener("click", () => {
        if (this.region) {
          this.waveSurfer.play(this.region.start, this.region.end);
        }
      });
    document
      .querySelector("#resetRegionButton")
      .addEventListener("click", () => {
        const duration = this.waveSurfer.getDuration();
        this.#setRegion(0, Math.min(duration, 10));
      });
    document.querySelector("#waveZoom").addEventListener("input", (event) => {
      this.waveSurfer.zoom(Number(event.target.value));
    });
    for (const input of [this.startInput, this.endInput]) {
      input.addEventListener("input", () => this.#syncRegionFromInputs());
    }
  }

  #setRegion(start, end) {
    this.regions.clearRegions();
    this.region = this.regions.addRegion({
      start,
      end,
      color: "rgba(255, 90, 162, 0.18)",
      drag: true,
      resize: true,
    });
    this.#syncInputsFromRegion();
  }

  #syncInputsFromRegion() {
    if (!this.region) return;
    this.startInput.value = this.region.start.toFixed(2);
    this.endInput.value = this.region.end.toFixed(2);
    this.#renderValidation();
  }

  #syncRegionFromInputs() {
    if (!this.region) return;
    const start = Number(this.startInput.value);
    const end = Number(this.endInput.value);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    this.suppressRegionUpdate = true;
    this.region.setOptions({ start, end });
    this.suppressRegionUpdate = false;
    this.#renderValidation();
  }

  #validation() {
    if (!this.region) return { ok: false, message: "等待音频" };
    const duration = this.region.end - this.region.start;
    if (this.region.end <= this.region.start) {
      return { ok: false, message: "结束时间必须晚于开始时间", duration };
    }
    if (duration < 3) {
      return { ok: false, message: "选区必须至少 3 秒", duration };
    }
    if (duration > 10) {
      return { ok: false, message: "选区不能超过 10 秒", duration };
    }
    if (this.region.end > this.waveSurfer.getDuration() + 0.001) {
      return { ok: false, message: "结束时间超过音频长度", duration };
    }
    return { ok: true, message: "时长有效", duration };
  }

  #renderValidation() {
    const validation = this.#validation();
    this.durationNode.textContent = `${Number(
      validation.duration || 0,
    ).toFixed(2)} 秒`;
    this.validationNode.textContent = validation.message;
    this.validationNode.className = validation.ok ? "valid" : "invalid";
    this.trimButton.disabled = !validation.ok;
  }

  #formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
}
