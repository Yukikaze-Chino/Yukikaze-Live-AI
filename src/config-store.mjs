import fs from "node:fs";
import path from "node:path";

import { normalizeConfig } from "./core.mjs";

export class ConfigStore {
  constructor(configPath) {
    this.configPath = configPath;
  }

  load() {
    if (!fs.existsSync(this.configPath)) {
      return normalizeConfig();
    }

    try {
      const content = fs.readFileSync(this.configPath, "utf8");
      return normalizeConfig(JSON.parse(content));
    } catch (error) {
      throw new Error(`无法读取配置文件 ${this.configPath}: ${error.message}`);
    }
  }

  save(input) {
    const current = fs.existsSync(this.configPath) ? this.load() : normalizeConfig();
    const requestedAi = input.ai || {};
    const requestedTools = requestedAi.tools || {};
    const normalized = normalizeConfig({
      ...current,
      ...input,
      captionTextBox: {
        ...current.captionTextBox,
        ...(input.captionTextBox || {}),
      },
      captionSpeakerLabelBox: {
        ...current.captionSpeakerLabelBox,
        ...(input.captionSpeakerLabelBox || {}),
      },
      tts: { ...current.tts, ...(input.tts || {}) },
      ttsProfiles: {
        ...current.ttsProfiles,
        ...(input.ttsProfiles || {}),
        manual: {
          ...current.ttsProfiles.manual,
          ...(input.tts || {}),
          ...(input.ttsProfiles?.manual || {}),
        },
        ai: {
          ...current.ttsProfiles.ai,
          ...(input.ttsProfiles?.ai || {}),
        },
      },
      browser: { ...current.browser, ...(input.browser || {}) },
      audioOutput: { ...current.audioOutput, ...(input.audioOutput || {}) },
      music: {
        ...current.music,
        ...(input.music || {}),
        biliNcm: {
          ...current.music.biliNcm,
          ...(input.music?.biliNcm || {}),
        },
        voiceMeeter: {
          ...current.music.voiceMeeter,
          ...(input.music?.voiceMeeter || {}),
        },
      },
      dialogueLog: { ...current.dialogueLog, ...(input.dialogueLog || {}) },
      speakerLabels: {
        ...current.speakerLabels,
        ...(input.speakerLabels || {}),
      },
      biliDanmaku: {
        ...current.biliDanmaku,
        ...(input.biliDanmaku || {}),
      },
      publish: { ...current.publish, ...(input.publish || {}) },
      ai: {
        ...current.ai,
        ...requestedAi,
        contextEventKinds: {
          ...current.ai.contextEventKinds,
          ...(requestedAi.contextEventKinds || {}),
        },
        tools: {
          ...current.ai.tools,
          ...requestedTools,
          webSearch: {
            ...current.ai.tools.webSearch,
            ...(requestedTools.webSearch || {}),
          },
        },
        scene: {
          ...current.ai.scene,
          ...(requestedAi.scene || {}),
          vision: {
            ...current.ai.scene.vision,
            ...(requestedAi.scene?.vision || {}),
          },
        },
      },
    });
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(
      this.configPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    return normalized;
  }
}
