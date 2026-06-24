import os from "node:os";
import path from "node:path";

const GPT_SOVITS_ROOT = "D:\\2-2-Other\\GPT-SoVITS";
const RESOURCE_ROOT = "D:\\2-2-Other\\Yukikaze-Live-AI\\resources";
const GPT_WEIGHTS_PATH = "";
const SOVITS_WEIGHTS_PATH = "";

export const DEFAULT_AI_CONTEXT_EVENT_KINDS = Object.freeze({
  danmaku: true,
  room_enter: true,
  follow: true,
  share: true,
  gift: true,
  online_snapshot: true,
  guard: true,
  super_chat: true,
  like: true,
  manual_line: true,
  ai_reply: true,
});

const DEFAULT_AI_TOOLS = Object.freeze({
  enabled: true,
  autoUseTools: true,
  dailySearchLimit: 0,
  maxSearchesPerReply: 1,
  webSearch: Object.freeze({
    enabled: true,
    provider: "tencent-wsa-mcp",
    transport: "streamable_http",
    endpoint: "",
    maxResults: 5,
  }),
});

const DEFAULT_AI_SCENE = Object.freeze({
  enabled: true,
  idleMinSeconds: 120,
  idleCooldownMinSeconds: 120,
  idleCooldownMaxSeconds: 300,
  vision: Object.freeze({
    enabled: false,
    targetType: "display",
    displayId: "",
    rollingWindowSeconds: 600,
    maxCapturesPerWindow: 10,
    verified: false,
  }),
});

const MIN_REPLY_AUDIO_GAP_SECONDS = -0.5;
const AI_PROVIDERS = new Set(["openai-compatible", "anthropic"]);
const MUSIC_OUTPUT_MODES = new Set([
  "stream_only",
  "stream_and_media",
  "media_only",
]);
const DEFAULT_MUSIC = Object.freeze({
  enabled: false,
  biliNcm: Object.freeze({
    baseUrl: "http://127.0.0.1:5555",
    executablePath: "",
    pollIntervalSeconds: 2,
  }),
  voiceMeeter: Object.freeze({
    enabled: false,
    remoteDllPath: "",
    inputStrip: "Strip[0]",
  }),
  outputMode: "stream_and_media",
});

const DEFAULT_SPEAKER_LABELS = Object.freeze({
  manual: "主播",
  ai: "雪风",
});

const DEFAULT_BILI_DANMAKU = Object.freeze({
  manualEnabled: false,
  aiEnabled: false,
});

export const DEFAULT_CONFIG = Object.freeze({
  serverPort: 17374,
  roomId: "",
  sendRealDanmaku: false,
  danmakuMaxLength: 40,
  ttsDelaySeconds: 3,
  captionDurationSeconds: 0,
  captionAnimation: "typewriter",
  captionFadeSeconds: 0.5,
  typewriterMillisecondsPerCharacter: 55,
  captionImagePath: "",
  publish: Object.freeze({
    enableTts: true,
    enableCaption: true,
  }),
  ai: Object.freeze({
    enabled: false,
    directorEnabled: true,
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "",
    directorThinkingEnabled: true,
    replyThinkingEnabled: true,
    thinkingLevel: "high",
    requestTimeoutSeconds: 120,
    persona: "",
    contextLimit: 100,
    localHistoryLimit: 300,
    memorySummaryInterval: 50,
    replyAudioGapSeconds: 0.5,
    contextEventKinds: DEFAULT_AI_CONTEXT_EVENT_KINDS,
    tools: DEFAULT_AI_TOOLS,
    scene: DEFAULT_AI_SCENE,
  }),
  captionTextBox: Object.freeze({
    x: 565,
    y: 982,
    width: 620,
    height: 72,
    fontSize: 30,
    minimumFontSize: 18,
    lineHeight: 1.35,
    color: "#4a4a4a",
    fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
    textAlign: "left",
  }),
  captionSpeakerLabelBox: Object.freeze({
    offsetX: -10,
    offsetY: -50,
    minWidth: 150,
    fontSize: 24,
  }),
  dialogueLog: Object.freeze({
    x: 1305,
    y: 680,
    width: 430,
    height: 360,
    fontSize: 24,
    maxLines: 5,
    itemMinHeight: 48,
    gap: 10,
  }),
  audioOutput: Object.freeze({
    mode: "system",
    volume: 1,
    primaryDeviceId: "",
    primaryDeviceLabel: "",
    monitorDeviceId: "",
    monitorDeviceLabel: "",
  }),
  music: DEFAULT_MUSIC,
  tts: Object.freeze({
    gradioEndpoint: "http://127.0.0.1:9872",
    endpoint: "http://127.0.0.1:9880",
    autoStartApi: true,
    resourceRoot: RESOURCE_ROOT,
    gptSoVitsRoot: GPT_SOVITS_ROOT,
    pythonPath: path.join(GPT_SOVITS_ROOT, "runtime", "python.exe"),
    refAudioPath: "",
    auxRefAudioPaths: Object.freeze([]),
    promptText: "",
    promptLang: "ja",
    textLang: "zh",
    topK: 15,
    topP: 1,
    temperature: 1,
    speedFactor: 1,
    textSplitMethod: "cut1",
    fragmentInterval: 0.3,
    sampleSteps: 8,
    gptWeightsPath: GPT_WEIGHTS_PATH,
    sovitsWeightsPath: SOVITS_WEIGHTS_PATH,
  }),
  browser: Object.freeze({
    edgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    userDataDir: path.join(
      process.env.APPDATA || os.homedir(),
      "YukikazeLiveAI",
      "edge-profile",
    ),
    roomUrl: "",
    headless: false,
  }),
});

function finiteNumber(value, fallback, minimum = Number.NEGATIVE_INFINITY) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function clampedFiniteNumber(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function safeLoopbackMusicUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      !allowedHosts.has(url.hostname) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return "";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function normalizeConfig(input = {}) {
  const captionTextBox = {
    ...DEFAULT_CONFIG.captionTextBox,
    ...(input.captionTextBox || {}),
  };
  const requestedCaptionSpeakerLabelBox = input.captionSpeakerLabelBox || {};
  const captionSpeakerLabelBox = {
    ...DEFAULT_CONFIG.captionSpeakerLabelBox,
    ...requestedCaptionSpeakerLabelBox,
    offsetX: finiteNumber(
      requestedCaptionSpeakerLabelBox.offsetX,
      DEFAULT_CONFIG.captionSpeakerLabelBox.offsetX,
    ),
    offsetY: finiteNumber(
      requestedCaptionSpeakerLabelBox.offsetY,
      DEFAULT_CONFIG.captionSpeakerLabelBox.offsetY,
    ),
    minWidth: Math.trunc(
      finiteNumber(
        requestedCaptionSpeakerLabelBox.minWidth,
        DEFAULT_CONFIG.captionSpeakerLabelBox.minWidth,
        1,
      ),
    ),
    fontSize: Math.trunc(
      finiteNumber(
        requestedCaptionSpeakerLabelBox.fontSize,
        DEFAULT_CONFIG.captionSpeakerLabelBox.fontSize,
        8,
      ),
    ),
  };
  const requestedDialogueLog = input.dialogueLog || {};
  const dialogueLog = {
    ...DEFAULT_CONFIG.dialogueLog,
    ...requestedDialogueLog,
    x: Math.trunc(
      finiteNumber(requestedDialogueLog.x, DEFAULT_CONFIG.dialogueLog.x, 0),
    ),
    y: Math.trunc(
      finiteNumber(requestedDialogueLog.y, DEFAULT_CONFIG.dialogueLog.y, 0),
    ),
    width: Math.trunc(
      finiteNumber(
        requestedDialogueLog.width,
        DEFAULT_CONFIG.dialogueLog.width,
        1,
      ),
    ),
    height: Math.trunc(
      finiteNumber(
        requestedDialogueLog.height,
        DEFAULT_CONFIG.dialogueLog.height,
        1,
      ),
    ),
    fontSize: Math.trunc(
      finiteNumber(
        requestedDialogueLog.fontSize,
        DEFAULT_CONFIG.dialogueLog.fontSize,
        8,
      ),
    ),
    maxLines: Math.trunc(
      finiteNumber(
        requestedDialogueLog.maxLines,
        DEFAULT_CONFIG.dialogueLog.maxLines,
        1,
      ),
    ),
    itemMinHeight: Math.trunc(
      finiteNumber(
        requestedDialogueLog.itemMinHeight,
        DEFAULT_CONFIG.dialogueLog.itemMinHeight,
        1,
      ),
    ),
    gap: Math.trunc(
      finiteNumber(
        requestedDialogueLog.gap,
        DEFAULT_CONFIG.dialogueLog.gap,
        0,
      ),
    ),
  };
  const legacyTts = {
    ...DEFAULT_CONFIG.tts,
    ...(input.tts || {}),
    auxRefAudioPaths: Array.isArray(input.tts?.auxRefAudioPaths)
      ? input.tts.auxRefAudioPaths.map(String)
      : [],
  };
  const requestedTtsProfiles = input.ttsProfiles || {};
  const normalizeTtsProfile = (requestedProfile = {}) => ({
    ...legacyTts,
    ...requestedProfile,
    auxRefAudioPaths: Array.isArray(requestedProfile.auxRefAudioPaths)
      ? requestedProfile.auxRefAudioPaths.map(String)
      : [...legacyTts.auxRefAudioPaths],
  });
  const ttsProfiles = {
    manual: normalizeTtsProfile(requestedTtsProfiles.manual),
    ai: normalizeTtsProfile(requestedTtsProfiles.ai),
  };
  // The legacy `tts` field remains the active manual profile for old controls.
  const tts = ttsProfiles.manual;
  const browser = { ...DEFAULT_CONFIG.browser, ...(input.browser || {}) };
  const requestedAudioOutput = input.audioOutput || {};
  const audioOutputMode = ["system", "single", "dual"].includes(
    requestedAudioOutput.mode,
  )
    ? requestedAudioOutput.mode
    : DEFAULT_CONFIG.audioOutput.mode;
  const audioOutput = {
    ...DEFAULT_CONFIG.audioOutput,
    ...requestedAudioOutput,
    mode: audioOutputMode,
    volume: Math.min(
      1,
      Math.max(
        0,
        finiteNumber(
          requestedAudioOutput.volume,
          DEFAULT_CONFIG.audioOutput.volume,
        ),
      ),
    ),
  };
  const requestedMusic = input.music || {};
  const requestedBiliNcm = requestedMusic.biliNcm || {};
  const requestedVoiceMeeter = requestedMusic.voiceMeeter || {};
  const music = {
    ...DEFAULT_MUSIC,
    ...requestedMusic,
    enabled: Boolean(requestedMusic.enabled ?? DEFAULT_MUSIC.enabled),
    biliNcm: {
      ...DEFAULT_MUSIC.biliNcm,
      ...requestedBiliNcm,
      baseUrl:
        safeLoopbackMusicUrl(requestedBiliNcm.baseUrl) ||
        DEFAULT_MUSIC.biliNcm.baseUrl,
      executablePath: String(
        requestedBiliNcm.executablePath ?? DEFAULT_MUSIC.biliNcm.executablePath,
      ).trim(),
      pollIntervalSeconds: Math.min(
        30,
        Math.max(
          1,
          Math.trunc(
            finiteNumber(
              requestedBiliNcm.pollIntervalSeconds,
              DEFAULT_MUSIC.biliNcm.pollIntervalSeconds,
              1,
            ),
          ),
        ),
      ),
    },
    voiceMeeter: {
      ...DEFAULT_MUSIC.voiceMeeter,
      ...requestedVoiceMeeter,
      enabled: Boolean(
        requestedVoiceMeeter.enabled ?? DEFAULT_MUSIC.voiceMeeter.enabled,
      ),
      remoteDllPath: String(
        requestedVoiceMeeter.remoteDllPath ??
          DEFAULT_MUSIC.voiceMeeter.remoteDllPath,
      ).trim(),
      inputStrip:
        String(
          requestedVoiceMeeter.inputStrip ??
            DEFAULT_MUSIC.voiceMeeter.inputStrip,
        ).trim() || DEFAULT_MUSIC.voiceMeeter.inputStrip,
    },
    outputMode: MUSIC_OUTPUT_MODES.has(requestedMusic.outputMode)
      ? requestedMusic.outputMode
      : DEFAULT_MUSIC.outputMode,
  };
  const requestedSpeakerLabels = input.speakerLabels || {};
  const speakerLabels = {
    manual:
      String(requestedSpeakerLabels.manual ?? DEFAULT_SPEAKER_LABELS.manual).trim() ||
      DEFAULT_SPEAKER_LABELS.manual,
    ai:
      String(requestedSpeakerLabels.ai ?? DEFAULT_SPEAKER_LABELS.ai).trim() ||
      DEFAULT_SPEAKER_LABELS.ai,
  };
  const requestedBiliDanmaku = input.biliDanmaku || {};
  const legacySendRealDanmaku = Boolean(input.sendRealDanmaku);
  const biliDanmaku = {
    manualEnabled: Boolean(
      requestedBiliDanmaku.manualEnabled ?? legacySendRealDanmaku,
    ),
    aiEnabled: Boolean(requestedBiliDanmaku.aiEnabled ?? legacySendRealDanmaku),
  };
  const animation = ["typewriter", "instant"].includes(input.captionAnimation)
    ? input.captionAnimation
    : DEFAULT_CONFIG.captionAnimation;
  const requestedPublish = input.publish || {};
  const publish = {
    ...DEFAULT_CONFIG.publish,
    ...requestedPublish,
    enableTts: Boolean(
      requestedPublish.enableTts ?? DEFAULT_CONFIG.publish.enableTts,
    ),
    enableCaption: Boolean(
      requestedPublish.enableCaption ?? DEFAULT_CONFIG.publish.enableCaption,
    ),
  };
  const requestedAi = input.ai || {};
  const provider = AI_PROVIDERS.has(String(requestedAi.provider || "").trim())
    ? String(requestedAi.provider).trim()
    : DEFAULT_CONFIG.ai.provider;
  const thinkingLevel = ["high", "max"].includes(requestedAi.thinkingLevel)
    ? requestedAi.thinkingLevel
    : DEFAULT_CONFIG.ai.thinkingLevel;
  const requestedContextKinds = requestedAi.contextEventKinds || {};
  const contextEventKinds = Object.fromEntries(
    Object.entries(DEFAULT_AI_CONTEXT_EVENT_KINDS).map(([kind, enabled]) => [
      kind,
      Boolean(requestedContextKinds[kind] ?? enabled),
    ]),
  );
  const requestedTools = requestedAi.tools || {};
  const requestedWebSearch = requestedTools.webSearch || {};
  const tools = {
    ...DEFAULT_AI_TOOLS,
    ...requestedTools,
    enabled: Boolean(requestedTools.enabled ?? DEFAULT_AI_TOOLS.enabled),
    autoUseTools: Boolean(
      requestedTools.autoUseTools ?? DEFAULT_AI_TOOLS.autoUseTools,
    ),
    dailySearchLimit: Math.trunc(
      finiteNumber(
        requestedTools.dailySearchLimit,
        DEFAULT_AI_TOOLS.dailySearchLimit,
        0,
      ),
    ),
    maxSearchesPerReply: Math.trunc(
      finiteNumber(
        requestedTools.maxSearchesPerReply,
        DEFAULT_AI_TOOLS.maxSearchesPerReply,
        0,
      ),
    ),
    webSearch: {
      ...DEFAULT_AI_TOOLS.webSearch,
      ...requestedWebSearch,
      enabled: Boolean(
        requestedWebSearch.enabled ?? DEFAULT_AI_TOOLS.webSearch.enabled,
      ),
      provider: String(
        requestedWebSearch.provider ?? DEFAULT_AI_TOOLS.webSearch.provider,
      ).trim(),
      transport: String(
        requestedWebSearch.transport ?? DEFAULT_AI_TOOLS.webSearch.transport,
      ).trim(),
      endpoint: String(
        requestedWebSearch.endpoint ?? DEFAULT_AI_TOOLS.webSearch.endpoint,
      ).trim(),
      maxResults: Math.trunc(
        finiteNumber(
          requestedWebSearch.maxResults,
          DEFAULT_AI_TOOLS.webSearch.maxResults,
          1,
        ),
      ),
    },
  };
  const requestedScene = requestedAi.scene || {};
  const requestedVision = requestedScene.vision || {};
  const idleCooldownMinSeconds = Math.trunc(
    finiteNumber(
      requestedScene.idleCooldownMinSeconds,
      DEFAULT_AI_SCENE.idleCooldownMinSeconds,
      1,
    ),
  );
  const scene = {
    ...DEFAULT_AI_SCENE,
    ...requestedScene,
    enabled: Boolean(requestedScene.enabled ?? DEFAULT_AI_SCENE.enabled),
    idleMinSeconds: Math.trunc(
      finiteNumber(
        requestedScene.idleMinSeconds,
        DEFAULT_AI_SCENE.idleMinSeconds,
        1,
      ),
    ),
    idleCooldownMinSeconds,
    idleCooldownMaxSeconds: Math.max(
      idleCooldownMinSeconds,
      Math.trunc(
        finiteNumber(
          requestedScene.idleCooldownMaxSeconds,
          DEFAULT_AI_SCENE.idleCooldownMaxSeconds,
          1,
        ),
      ),
    ),
    vision: {
      ...DEFAULT_AI_SCENE.vision,
      ...requestedVision,
      enabled: Boolean(
        requestedVision.enabled ?? DEFAULT_AI_SCENE.vision.enabled,
      ),
      targetType: "display",
      displayId: String(
        requestedVision.displayId ?? DEFAULT_AI_SCENE.vision.displayId,
      ).trim(),
      rollingWindowSeconds: Math.trunc(
        finiteNumber(
          requestedVision.rollingWindowSeconds,
          DEFAULT_AI_SCENE.vision.rollingWindowSeconds,
          1,
        ),
      ),
      maxCapturesPerWindow: Math.trunc(
        finiteNumber(
          requestedVision.maxCapturesPerWindow,
          DEFAULT_AI_SCENE.vision.maxCapturesPerWindow,
          1,
        ),
      ),
      verified: false,
    },
  };
  const ai = {
    ...DEFAULT_CONFIG.ai,
    ...requestedAi,
    enabled: Boolean(requestedAi.enabled ?? DEFAULT_CONFIG.ai.enabled),
    directorEnabled: Boolean(
      requestedAi.directorEnabled ?? DEFAULT_CONFIG.ai.directorEnabled,
    ),
    provider,
    baseUrl: String(requestedAi.baseUrl ?? DEFAULT_CONFIG.ai.baseUrl).trim(),
    model: String(requestedAi.model ?? DEFAULT_CONFIG.ai.model).trim(),
    directorThinkingEnabled: Boolean(
      requestedAi.directorThinkingEnabled ??
        DEFAULT_CONFIG.ai.directorThinkingEnabled,
    ),
    replyThinkingEnabled: Boolean(
      requestedAi.replyThinkingEnabled ?? DEFAULT_CONFIG.ai.replyThinkingEnabled,
    ),
    thinkingLevel,
    requestTimeoutSeconds: finiteNumber(
      requestedAi.requestTimeoutSeconds,
      DEFAULT_CONFIG.ai.requestTimeoutSeconds,
      1,
    ),
    persona: String(requestedAi.persona ?? DEFAULT_CONFIG.ai.persona).trim(),
    contextLimit: Math.trunc(
      finiteNumber(requestedAi.contextLimit, DEFAULT_CONFIG.ai.contextLimit, 1),
    ),
    localHistoryLimit: Math.trunc(
      finiteNumber(
        requestedAi.localHistoryLimit,
        DEFAULT_CONFIG.ai.localHistoryLimit,
        1,
      ),
    ),
    memorySummaryInterval: Math.trunc(
      finiteNumber(
        requestedAi.memorySummaryInterval,
        DEFAULT_CONFIG.ai.memorySummaryInterval,
        1,
      ),
    ),
    replyAudioGapSeconds: clampedFiniteNumber(
      requestedAi.replyAudioGapSeconds,
      DEFAULT_CONFIG.ai.replyAudioGapSeconds,
      MIN_REPLY_AUDIO_GAP_SECONDS,
    ),
    contextEventKinds,
    tools,
    scene,
  };

  return {
    ...DEFAULT_CONFIG,
    ...input,
    sendRealDanmaku: Boolean(input.sendRealDanmaku),
    serverPort: Math.trunc(
      finiteNumber(input.serverPort, DEFAULT_CONFIG.serverPort, 1),
    ),
    danmakuMaxLength: Math.trunc(
      finiteNumber(
        input.danmakuMaxLength,
        DEFAULT_CONFIG.danmakuMaxLength,
        1,
      ),
    ),
    ttsDelaySeconds: finiteNumber(
      input.ttsDelaySeconds,
      DEFAULT_CONFIG.ttsDelaySeconds,
      0,
    ),
    captionDurationSeconds: finiteNumber(
      input.captionDurationSeconds,
      DEFAULT_CONFIG.captionDurationSeconds,
      0,
    ),
    captionFadeSeconds: finiteNumber(
      input.captionFadeSeconds,
      DEFAULT_CONFIG.captionFadeSeconds,
      0,
    ),
    typewriterMillisecondsPerCharacter: finiteNumber(
      input.typewriterMillisecondsPerCharacter,
      DEFAULT_CONFIG.typewriterMillisecondsPerCharacter,
      1,
    ),
    captionAnimation: animation,
    captionTextBox,
    captionSpeakerLabelBox,
    dialogueLog,
    speakerLabels,
    biliDanmaku,
    audioOutput,
    music,
    publish,
    ai,
    tts,
    ttsProfiles,
    browser,
  };
}

export function buildDanmakuText(text, maximumLength) {
  return Array.from(String(text).trim()).slice(0, maximumLength).join("");
}

export function buildPublishPlan(config, text, { source = "manual" } = {}) {
  const normalizedSource = String(source || "manual");
  const isLocalTest = normalizedSource === "ai-test";
  const isAi = normalizedSource.startsWith("ai");
  const shouldSend = !isLocalTest && Boolean(
    isAi ? config.biliDanmaku?.aiEnabled : config.biliDanmaku?.manualEnabled,
  );
  return {
    shouldSend,
    text: String(text || ""),
    ...(shouldSend
      ? {}
      : {
          reason: isLocalTest
            ? "本地 AI 测试不会发送真实弹幕"
            : "真实弹幕已关闭",
        }),
  };
}

function comparableFilePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").toLowerCase();
}

export function normalizeAuxiliaryReferencePaths(paths, primaryPath) {
  const primary = comparableFilePath(primaryPath);
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    const filePath = String(value || "").trim();
    const comparable = comparableFilePath(filePath);
    if (!filePath || comparable === primary || seen.has(comparable)) continue;
    seen.add(comparable);
    normalized.push(filePath);
  }
  return normalized;
}

export function createCaptionEvent(
  text,
  config,
  id = Date.now(),
  { source = "manual" } = {},
) {
  const normalizedSource = String(source || "manual");
  const isAi = normalizedSource.startsWith("ai");
  return {
    id,
    text: String(text),
    visible: true,
    animation: config.captionAnimation,
    durationSeconds: config.captionDurationSeconds,
    fadeSeconds: config.captionFadeSeconds,
    textBox: { ...config.captionTextBox },
    speakerLabelBox: { ...config.captionSpeakerLabelBox },
    source: normalizedSource,
    speakerLabel: isAi
      ? config.speakerLabels?.ai || "雪风"
      : config.speakerLabels?.manual || "主播",
  };
}

export function buildTtsRequest(text, config) {
  const tts = config.tts;
  return {
    text: String(text),
    text_lang: apiLanguageCode(tts.textLang),
    ref_audio_path: tts.refAudioPath,
    aux_ref_audio_paths: normalizeAuxiliaryReferencePaths(
      tts.auxRefAudioPaths,
      tts.refAudioPath,
    ),
    prompt_text: tts.promptText,
    prompt_lang: apiLanguageCode(tts.promptLang),
    top_k: Number(tts.topK),
    top_p: Number(tts.topP),
    temperature: Number(tts.temperature),
    text_split_method: tts.textSplitMethod,
    batch_size: 1,
    batch_threshold: 0.75,
    split_bucket: true,
    speed_factor: Number(tts.speedFactor),
    fragment_interval: Number(tts.fragmentInterval),
    seed: -1,
    media_type: "wav",
    streaming_mode: false,
    parallel_infer: true,
    repetition_penalty: 1.35,
    sample_steps: Number(tts.sampleSteps),
    super_sampling: false,
    overlap_length: 2,
    min_chunk_length: 16,
  };
}

const API_LANGUAGE_CODES = Object.freeze({
  zh: "all_zh",
  cn: "all_zh",
  ja: "all_ja",
  jp: "all_ja",
  yue: "all_yue",
  ko: "all_ko",
  en: "en",
  zh_en: "zh",
  ja_en: "ja",
  yue_en: "yue",
  ko_en: "ko",
  auto: "auto",
  auto_yue: "auto_yue",
});

function apiLanguageCode(value) {
  const code = String(value).toLowerCase();
  return API_LANGUAGE_CODES[code] || code;
}

const LANGUAGE_LABELS = Object.freeze({
  zh: "中文",
  cn: "中文",
  ja: "日文",
  jp: "日文",
  en: "英文",
  yue: "粤语",
  ko: "韩文",
  zh_en: "中英混合",
  ja_en: "日英混合",
  yue_en: "粤英混合",
  ko_en: "韩英混合",
  auto: "多语种混合",
  auto_yue: "多语种混合(粤语)",
});

const CUT_METHOD_LABELS = Object.freeze({
  cut0: "不切",
  none: "不切",
  cut1: "凑四句一切",
  cut2: "凑50字一切",
  cut3: "按中文句号。切",
  cut4: "按英文句号.切",
  cut5: "按标点符号切",
});

function gradioLanguageLabel(value) {
  return LANGUAGE_LABELS[String(value).toLowerCase()] || String(value);
}

function gradioCutLabel(value) {
  return CUT_METHOD_LABELS[String(value).toLowerCase()] || String(value);
}

export function buildGradioTtsArgs(text, config) {
  const tts = config.tts;
  return [
    tts.refAudioPath,
    tts.promptText,
    gradioLanguageLabel(tts.promptLang),
    String(text),
    gradioLanguageLabel(tts.textLang),
    gradioCutLabel(tts.textSplitMethod),
    Number(tts.topK),
    Number(tts.topP),
    Number(tts.temperature),
    false,
    Number(tts.speedFactor),
    false,
    normalizeAuxiliaryReferencePaths(
      tts.auxRefAudioPaths,
      tts.refAudioPath,
    ),
    Number(tts.sampleSteps),
    false,
    Number(tts.fragmentInterval),
    true,
  ];
}
