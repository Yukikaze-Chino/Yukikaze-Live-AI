import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCurrentTimeContext,
  contextReadLimit,
  localHistoryLimit,
  readVisibleAiContext,
} from "./ai-context.mjs";
import { AiChatClient } from "./ai-client.mjs";
import {
  applyMemorySummaryResult,
  buildMemorySummaryMessages,
  parseMemorySummaryResult,
} from "./ai-memory-manager.mjs";
import { AiMemoryStore } from "./ai-memory.mjs";
import { AiOrchestrator } from "./ai-orchestrator.mjs";
import { BiliSender } from "./bili-sender.mjs";
import { BiliReceiver } from "./bili-receiver.mjs";
import { BiliMusicLogStore } from "./bili-music-log-store.mjs";
import { AudioEditor } from "./audio-editor.mjs";
import { readWavDurationSeconds } from "./audio-duration.mjs";
import { ConfigStore } from "./config-store.mjs";
import {
  DEFAULT_CONFIG,
  buildPublishPlan,
} from "./core.mjs";
import { FontLibrary } from "./font-library.mjs";
import { MusicCollaborator } from "./music-collaborator.mjs";
import { ResourceLibrary } from "./resource-library.mjs";
import { ReplyQueue } from "./reply-queue.mjs";
import { SecretStore } from "./secret-store.mjs";
import {
  CaptionAudioStore,
  CaptionStore,
  DialogueLogStore,
  createLineJob,
} from "./state.mjs";
import { createTestToneWav } from "./test-tone.mjs";
import {
  TtsClient,
  validateAuxiliaryReferences,
} from "./tts-client.mjs";
import { TtsManager } from "./tts-manager.mjs";
import { resolveTtsProfile } from "./tts-profile-resolver.mjs";
import { VoiceMeeterRouter } from "./voicemeeter-router.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "YukikazeLiveAI",
);
const AUDIO_DIR = path.join(APP_DIR, "audio");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const AI_MEMORY_PATH = path.join(APP_DIR, "ai-memory.sqlite");
const SECRET_PATH = path.join(APP_DIR, "secrets.json");

const configStore = new ConfigStore(CONFIG_PATH);
let config = configStore.load();
const resourceLibrary = new ResourceLibrary({
  resourceRoot: config.tts.resourceRoot,
});
const audioEditor = new AudioEditor({
  library: resourceLibrary,
  gptSoVitsRoot: config.tts.gptSoVitsRoot,
});
const fontLibrary = new FontLibrary();
const captions = new CaptionStore();
const captionAudio = new CaptionAudioStore();
const dialogueLog = new DialogueLogStore({ limit: 50 });
const musicLog = new BiliMusicLogStore();
const jobs = new Map();
const biliSender = new BiliSender();
const ttsManager = new TtsManager({ appDirectory: APP_DIR });
const musicCollaborator = new MusicCollaborator();
const voiceMeeterRouter = new VoiceMeeterRouter();
const ttsClient = new TtsClient({
  audioDirectory: AUDIO_DIR,
  manager: ttsManager,
  library: resourceLibrary,
  audioEditor,
});
const aiTtsStatus = {
  current: null,
  recent: [],
};
const secrets = new SecretStore(SECRET_PATH);
const aiMemory = new AiMemoryStore(AI_MEMORY_PATH);
aiMemory.markStartupInterrupted();
const aiClient = new AiChatClient();
const biliReceiver = new BiliReceiver({
  pageProvider: () => biliSender.ensurePage(config),
});
const replyQueue = new ReplyQueue({
  executeSegment: async (segment) => {
    const job = createLineJob(segment.text, config, segment.id, {
      source: segment.source || "ai",
    });
    jobs.set(job.id, job);
    if (job.publish.enableTts) {
      startAiTtsStatus(job, segment);
      try {
        const audioPath = await ttsClient.synthesize(job, resolveTtsProfile(config, job.publish?.source));
        job.audioPath = audioPath;
        job.audioDurationSeconds = readWavDurationSeconds(audioPath);
        finishAiTtsStatus(job, audioPath);
      } catch (error) {
        failAiTtsStatus(job, error);
        throw error;
      }
    } else {
      skipAiTtsStatus(job, segment, "TTS 发布已关闭");
    }
    await publishJob(job);
    return {
      delaySeconds:
        Number(job.audioDurationSeconds || 0) +
        Number(config.ai?.replyAudioGapSeconds || 0),
    };
  },
});
const aiOrchestrator = new AiOrchestrator({
  configProvider: () => config,
  memory: aiMemory,
  secrets,
  aiClient,
  queue: replyQueue,
  receiver: biliReceiver,
});

function json(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
  });
  res.end(content);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function binary(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".ico": "image/x-icon",
    }[extension] || "application/octet-stream"
  );
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    text(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicConfig() {
  return {
    ...config,
    appDataDir: APP_DIR,
    configPath: CONFIG_PATH,
    captionSourceUrl: `http://127.0.0.1:${config.serverPort}/caption`,
    captionVisualOnlyUrl: `http://127.0.0.1:${config.serverPort}/caption?audio=0`,
    dialogueSourceUrl: `http://127.0.0.1:${config.serverPort}/dialogue`,
    logOverlayUrl: `http://127.0.0.1:${config.serverPort}/log-overlay`,
    audioPlayerUrl: `http://127.0.0.1:${config.serverPort}/audio-player`,
    controlUrl: `http://127.0.0.1:${config.serverPort}/control`,
  };
}

function aiAudioUrl(audioPath) {
  const fileName = path.basename(String(audioPath || ""));
  return fileName ? `/audio/${encodeURIComponent(fileName)}` : "";
}

function createAiTtsStatusEntry(job, segment, status) {
  return {
    id: job.id,
    taskId: segment.taskId || "",
    source: job.publish?.source || segment.source || "ai",
    status,
    text: job.text,
    audioPath: "",
    audioUrl: "",
    audioDurationSeconds: 0,
    error: "",
    startedAt: new Date().toISOString(),
    finishedAt: "",
  };
}

function pushRecentAiTtsStatus(entry) {
  aiTtsStatus.recent = [structuredClone(entry), ...aiTtsStatus.recent].slice(
    0,
    10,
  );
}

function startAiTtsStatus(job, segment) {
  aiTtsStatus.current = createAiTtsStatusEntry(job, segment, "running");
}

function finishAiTtsStatus(job, audioPath) {
  const entry =
    aiTtsStatus.current?.id === job.id
      ? { ...aiTtsStatus.current }
      : createAiTtsStatusEntry(job, {}, "running");
  entry.status = "completed";
  entry.audioPath = String(audioPath || "");
  entry.audioUrl = aiAudioUrl(audioPath);
  entry.audioDurationSeconds = Number(job.audioDurationSeconds || 0);
  entry.finishedAt = new Date().toISOString();
  aiTtsStatus.current = null;
  pushRecentAiTtsStatus(entry);
}

function failAiTtsStatus(job, error) {
  const entry =
    aiTtsStatus.current?.id === job.id
      ? { ...aiTtsStatus.current }
      : createAiTtsStatusEntry(job, {}, "running");
  entry.status = "failed";
  entry.error = error instanceof Error ? error.message : String(error);
  entry.finishedAt = new Date().toISOString();
  aiTtsStatus.current = null;
  pushRecentAiTtsStatus(entry);
}

function skipAiTtsStatus(job, segment, reason) {
  const entry = createAiTtsStatusEntry(job, segment, "skipped");
  entry.error = reason;
  entry.finishedAt = new Date().toISOString();
  pushRecentAiTtsStatus(entry);
}

function publicAiTtsStatus() {
  return structuredClone(aiTtsStatus);
}

function migrateTtsConfig() {
  const recommended = resourceLibrary.initialize({ defaults: {} });
  const currentSelection = {
    gptWeightsPath: resourceLibrary.isManagedResource(
      "gpt",
      config.tts.gptWeightsPath,
    )
      ? config.tts.gptWeightsPath
      : recommended.gptWeightsPath,
    sovitsWeightsPath: resourceLibrary.isManagedResource(
      "sovits",
      config.tts.sovitsWeightsPath,
    )
      ? config.tts.sovitsWeightsPath
      : recommended.sovitsWeightsPath,
    refAudioPath: resourceLibrary.isManagedResource(
      "reference",
      config.tts.refAudioPath,
    )
      ? config.tts.refAudioPath
      : recommended.refAudioPath,
  };
  const isFirstManagedMigration =
    currentSelection.gptWeightsPath !== config.tts.gptWeightsPath ||
    currentSelection.sovitsWeightsPath !== config.tts.sovitsWeightsPath ||
    currentSelection.refAudioPath !== config.tts.refAudioPath;
  const currentAiProfile = config.ttsProfiles?.ai || config.tts;
  const aiSelection = {
    gptWeightsPath: resourceLibrary.isManagedResource(
      "gpt",
      currentAiProfile.gptWeightsPath,
    )
      ? currentAiProfile.gptWeightsPath
      : currentSelection.gptWeightsPath,
    sovitsWeightsPath: resourceLibrary.isManagedResource(
      "sovits",
      currentAiProfile.sovitsWeightsPath,
    )
      ? currentAiProfile.sovitsWeightsPath
      : currentSelection.sovitsWeightsPath,
    refAudioPath: resourceLibrary.isManagedResource(
      "reference",
      currentAiProfile.refAudioPath,
    )
      ? currentAiProfile.refAudioPath
      : currentSelection.refAudioPath,
  };

  config = configStore.save({
    tts: {
      ...currentSelection,
      resourceRoot: resourceLibrary.paths.root,
      autoStartApi: true,
      ...(isFirstManagedMigration
        ? {
            speedFactor: 1,
            fragmentInterval: 0.3,
            textSplitMethod: "cut1",
          }
        : {}),
    },
    ttsProfiles: { ai: aiSelection },
  });
  const referenceName = path.basename(currentSelection.refAudioPath);
  if (currentSelection.refAudioPath && !audioEditor.getMetadata(referenceName)) {
    const audio = audioEditor.probeAudio(currentSelection.refAudioPath);
    audioEditor.saveMetadata(referenceName, {
      promptText: config.tts.promptText || DEFAULT_CONFIG.tts.promptText,
      promptLang: config.tts.promptLang || "ja",
      sourceName: referenceName,
      trimStart: 0,
      trimEnd: audio.durationSeconds,
      durationSeconds: audio.durationSeconds,
    });
  }
}

function migrateCaptionConfig() {
  const textBox = config.captionTextBox;
  if (Number(textBox.height) <= 72) {
    config = configStore.save({
      captionTextBox: {
        height: 96,
        minimumFontSize: Number(textBox.minimumFontSize || 18),
      },
    });
  }
}

async function prepareTtsAssets() {
  const prepared = await ttsManager.prepare(config);
  if (
    path.resolve(config.tts.refAudioPath) !==
    path.resolve(prepared.referenceAudioPath)
  ) {
    config = configStore.save({
      tts: { refAudioPath: prepared.referenceAudioPath },
    });
  }
  return prepared;
}

async function handleTtsAction(res, action) {
  try {
    let result;
    if (action === "start") result = await ttsManager.start(config);
    if (action === "restart") result = await ttsManager.restart(config);
    if (action === "stop") result = await ttsManager.stop(config);
    json(res, 200, { ok: true, tts: result });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

async function handleResourceImport(req, res, url) {
  try {
    const type = String(url.searchParams.get("type") || "");
    const encodedName = String(req.headers["x-file-name"] || "");
    const fileName = decodeURIComponent(encodedName);
    const importTarget = resourceLibrary.createImportStream({ type, fileName });
    req.pipe(importTarget.writeStream);
    req.once("aborted", () => {
      importTarget.writeStream.destroy(new Error("上传已取消"));
    });
    const imported = await importTarget.completed;
    let audio = null;
    if (type === "reference") {
      audio = audioEditor.probeAudio(imported.path);
    }
    json(res, 200, {
      ok: true,
      imported,
      audio,
      resources: resourceLibrary.listResources(config),
    });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function publishJob(job) {
  const source = job.publish?.source || "manual";
  const caption = job.publish?.enableCaption
    ? captions.publish(job.text, config, { source })
    : captions.current();
  if (source.startsWith("ai")) {
    dialogueLog.record({
      id: job.id,
      text: job.text,
      source: "ai",
    });
  }
  if (job.audioPath) {
    captionAudio.publish({
      jobId: job.id,
      text: job.text,
      audioUrl: `/audio/${encodeURIComponent(path.basename(job.audioPath))}`,
      source,
      audioDurationSeconds: Number(job.audioDurationSeconds || 0),
      playWindowSeconds: Number(job.audioDurationSeconds || 0) + 5,
    });
  }
  const publishPlan = job.publish?.source === "ai-test"
    ? {
        shouldSend: false,
        text: job.danmakuText,
        reason: "local AI test message",
      }
    : buildPublishPlan(config, job.danmakuText, { source });
  const bili = publishPlan.shouldSend
    ? await biliSender.send(publishPlan.text, config)
    : {
        ok: true,
        skipped: true,
        reason: publishPlan.reason,
      };
  if (publishPlan.shouldSend) {
    biliReceiver.ignorePageDanmakuText(publishPlan.text);
  }
  if (
    job.publish?.source !== "ai" &&
    job.publish?.source !== "ai-test" &&
    job.publish?.source !== "ai-idle"
  ) {
    aiMemory.recordConversationEvent({
      id: `manual-${job.id}`,
      kind: "manual_line",
      text: job.text,
    });
    aiMemory.trimConversationEvents(localHistoryLimit(config));
  }
  return { caption, bili, job };
}

function startAiServices() {
  aiOrchestrator.start();
  biliReceiver.start({ roomId: config.roomId }).catch((error) => {
    console.error("AI danmaku receiver failed:", error);
  });
}

function stopAiServices() {
  aiOrchestrator.stop();
  biliReceiver.stop();
}

function syncAiServices(previousConfig) {
  if (!previousConfig.ai.enabled && config.ai.enabled) {
    startAiServices();
    return;
  }
  if (previousConfig.ai.enabled && !config.ai.enabled) {
    stopAiServices();
    return;
  }
  if (config.ai.enabled && previousConfig.roomId !== config.roomId) {
    startAiServices();
  }
}

function getAiContextSnapshot() {
  const now = new Date();
  const storedEvents = aiMemory.getRecentConversationEvents({
    limit: contextReadLimit(config),
  });
  return {
    currentTime: buildCurrentTimeContext({ now }),
    events: readVisibleAiContext({ config, memory: aiMemory, now }),
    storedEvents,
    contextLimit: config.ai.contextLimit,
    localHistoryLimit: config.ai.localHistoryLimit,
    contextEventKinds: config.ai.contextEventKinds,
  };
}

function getAiMemorySnapshot({ type = "", status = "" } = {}) {
  return {
    summary: aiMemory.getStreamSummary(),
    recentEvents: aiMemory.getRecentConversationEvents({
      limit: contextReadLimit(config),
    }),
    longTerm: aiMemory.listVisibleLongTermMemories({
      type,
      limit: 200,
    }),
    pending: [],
    revisions: aiMemory.listMemoryRevisions({ limit: 20 }),
  };
}

async function generateMemorySummary() {
  const recentEvents = aiMemory.getRecentConversationEvents({
    limit: contextReadLimit(config),
  });
  const longTermMemories = aiMemory.listLongTermMemories({
    status: "active",
    limit: 100,
  });
  const content = await aiClient.complete({
    baseUrl: config.ai.baseUrl,
    apiKey: secrets.getAiApiKey(),
    model: config.ai.model,
    messages: buildMemorySummaryMessages({
      persona: config.ai.persona,
      shortTermSummary: aiMemory.getStreamSummary(),
      recentEvents,
      longTermMemories,
    }),
    json: true,
    thinkingEnabled: config.ai.replyThinkingEnabled,
    thinkingLevel: config.ai.thinkingLevel,
    timeoutSeconds: config.ai.requestTimeoutSeconds,
  });
  const parsed = parseMemorySummaryResult(content);
  const applied = applyMemorySummaryResult(aiMemory, parsed);
  return { parsed, applied };
}

function disabledMusicState() {
  return {
    connected: false,
    stale: false,
    error: "点歌协作尚未启用。",
    status: "",
    accepting: false,
    playing: false,
    cdpConnected: false,
    current: { id: "", title: "", artist: "", requester: "" },
    queue: [],
    rejects: [],
    updatedAt: "",
  };
}

function disabledVoiceMeeterState() {
  return {
    ok: false,
    A1: 0,
    B1: 0,
    inputStrip: config.music.voiceMeeter.inputStrip,
    error: "VoiceMeeter 协作尚未启用。",
  };
}

async function getMusicCollaborationStatus() {
  const music = config.music.enabled
    ? await musicCollaborator.refresh(config.music.biliNcm.baseUrl)
    : disabledMusicState();
  const voiceMeeter = config.music.voiceMeeter.enabled
    ? await voiceMeeterRouter.status(config.music.voiceMeeter)
    : disabledVoiceMeeterState();
  recordMusicStatus(music);
  return { music, voiceMeeter };
}

function recordMusicStatus(music) {
  if (!music?.connected) return;
  if (music.logsAvailable) {
    musicLog.syncBackendLogs(music.logs);
    return;
  }
  musicLog.record({
    kind: "music_connection",
    message: music.cdpConnected ? "点歌器已连接，网易云 CDP 已就绪。" : "点歌器已连接。",
  });
  if (music.current?.title) {
    musicLog.record({
      kind: "music_playing",
      message: `当前播放：${music.current.title}${music.current.artist ? ` - ${music.current.artist}` : ""}`,
    });
  }
  const queue = Array.isArray(music.queue) ? music.queue : [];
  musicLog.record({
    kind: "music_queue",
    message: queue.length
      ? `待播队列 ${queue.length} 首：${queue.slice(0, 3).map((item) => item.title || "未命名歌曲").join("、")}`
      : "点歌队列为空。",
  });
  const latestReject = Array.isArray(music.rejects) ? music.rejects.at(-1) : null;
  if (latestReject?.reason) {
    musicLog.record({
      kind: "music_reject",
      message: `点歌未加入：${latestReject.reason}`,
    });
  }
}

function requireMusicCollaboration() {
  if (!config.music.enabled) {
    throw new Error("请先在控制台启用点歌协作。");
  }
}

function validateBiliNcmExecutablePath() {
  const executablePath = String(config.music.biliNcm.executablePath || "").trim();
  if (!executablePath || path.extname(executablePath).toLowerCase() !== ".exe") {
    throw new Error("请选择 BiliNCM 的 .exe 启动文件。");
  }
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error("找不到已配置的 BiliNCM 启动文件。");
  }
  return executablePath;
}

async function launchBiliNcm() {
  const executablePath = validateBiliNcmExecutablePath();
  const child = spawn(executablePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { pid: child.pid };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, { ok: true, config: publicConfig() });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    const body = await readJson(req);
    const partial = body.config || body;
    const previousConfig = config;
    config = configStore.save(partial);
    if (partial.tts || partial.ttsProfiles) {
      try {
        await prepareTtsAssets();
        for (const source of ["manual", "ai"]) {
          validateAuxiliaryReferences(resolveTtsProfile(config, source), {
            library: resourceLibrary,
            audioEditor,
          });
        }
      } catch (error) {
        config = configStore.save(previousConfig);
        json(res, 400, { ok: false, error: error.message });
        return;
      }
    }
    syncAiServices(previousConfig);
    json(res, 200, { ok: true, config: publicConfig() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    json(res, 200, {
      ok: true,
      caption: captions.current(),
      audio: captionAudio.current(),
      dialogueLog: dialogueLog.current({ limit: config.dialogueLog.maxLines }),
      musicLog: musicLog.current(),
      config: publicConfig(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    json(res, 200, {
      ok: true,
      browser: biliSender.status(),
      tts: await ttsClient.probe(config),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/music/status") {
    const status = await getMusicCollaborationStatus();
    json(res, 200, { ok: true, ...status });
    return;
  }

  if (req.method === "GET" && pathname === "/api/music/log") {
    await getMusicCollaborationStatus();
    json(res, 200, { ok: true, musicLog: musicLog.current() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/music/start") {
    try {
      requireMusicCollaboration();
      const launched = await launchBiliNcm();
      musicLog.record({ kind: "music_launch", message: "已启动 BiliNCM 点歌器。" });
      json(res, 200, { ok: true, ...launched });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/music/queue-action") {
    try {
      requireMusicCollaboration();
      const body = await readJson(req);
      const result = await musicCollaborator.queueAction(
        config.music.biliNcm.baseUrl,
        {
          action: body.action,
          ...(Number.isInteger(body.index) ? { index: body.index } : {}),
        },
      );
      musicLog.record({ kind: "music_action", message: `点歌队列操作：${body.action}` });
      json(res, 200, { ok: true, result });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/music/toggle-accepting") {
    try {
      requireMusicCollaboration();
      const result = await musicCollaborator.toggleAccepting(
        config.music.biliNcm.baseUrl,
      );
      musicLog.record({ kind: "music_accepting", message: "已切换点歌接收状态。" });
      json(res, 200, { ok: true, result });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/music/toggle-playback") {
    try {
      requireMusicCollaboration();
      const result = await musicCollaborator.togglePlayback(
        config.music.biliNcm.baseUrl,
      );
      musicLog.record({ kind: "music_playback", message: "已切换点歌播放状态。" });
      json(res, 200, { ok: true, result });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/music/output-mode") {
    try {
      requireMusicCollaboration();
      if (!config.music.voiceMeeter.enabled) {
        throw new Error("请先在控制台启用 VoiceMeeter 协作。");
      }
      const body = await readJson(req);
      const result = await voiceMeeterRouter.apply({
        mode: body.mode,
        remoteDllPath: config.music.voiceMeeter.remoteDllPath,
        inputStrip: config.music.voiceMeeter.inputStrip,
      });
      config = configStore.save({
        music: { outputMode: result.mode },
      });
      json(res, 200, { ok: true, voiceMeeter: result, config: publicConfig() });
    } catch (error) {
      json(res, 409, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/resources") {
    json(res, 200, {
      ok: true,
      resources: resourceLibrary.listResources(config),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/fonts") {
    try {
      json(res, 200, {
        ok: true,
        fonts: fontLibrary.listInstalledFonts(),
      });
    } catch (error) {
      json(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/audio/metadata") {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const name = String(url.searchParams.get("name") || "");
      const filePath = resourceLibrary.resolveReference(name);
      json(res, 200, {
        ok: true,
        name,
        audio: audioEditor.probeAudio(filePath),
        metadata: audioEditor.getMetadata(name),
        audioUrl: `/resource/reference/${encodeURIComponent(name)}`,
      });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "PUT" && pathname === "/api/audio/metadata") {
    try {
      const body = await readJson(req);
      const filePath = resourceLibrary.resolveReference(body.name);
      const audio = audioEditor.probeAudio(filePath);
      const existing = audioEditor.getMetadata(body.name) || {};
      const metadata = audioEditor.saveMetadata(body.name, {
        ...existing,
        promptText: body.promptText,
        promptLang: body.promptLang,
        sourceName: existing.sourceName || body.name,
        durationSeconds: audio.durationSeconds,
        trimEnd: existing.trimEnd || audio.durationSeconds,
      });
      json(res, 200, { ok: true, metadata });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/audio/trim") {
    try {
      const body = await readJson(req);
      const result = audioEditor.trim(body);
      config = configStore.save({
        tts: {
          refAudioPath: result.path,
          promptText: result.metadata.promptText,
          promptLang: result.metadata.promptLang,
        },
      });
      json(res, 200, {
        ok: true,
        result,
        config: publicConfig(),
        resources: resourceLibrary.listResources(config),
      });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/tts/start") {
    await handleTtsAction(res, "start");
    return;
  }
  if (req.method === "POST" && pathname === "/api/tts/restart") {
    await handleTtsAction(res, "restart");
    return;
  }
  if (req.method === "POST" && pathname === "/api/tts/stop") {
    await handleTtsAction(res, "stop");
    return;
  }

  if (req.method === "POST" && pathname === "/api/browser/open") {
    try {
      json(res, 200, await biliSender.openForLogin(config));
    } catch (error) {
      json(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/prepare") {
    const body = await readJson(req);
    const job = createLineJob(body.text || "", config, undefined, {
      source: body.source || "manual",
      enableTts: body.enableTts,
    });
    if (!job.text) {
      json(res, 400, { ok: false, error: "请输入要发送的台词。" });
      return;
    }
    jobs.set(job.id, job);
    if (!job.publish.enableTts) {
      json(res, 200, { ok: true, job, audioUrl: "" });
      return;
    }
    try {
      const audioPath = await ttsClient.synthesize(job, resolveTtsProfile(config, job.publish?.source));
      job.audioPath = audioPath;
      json(res, 200, {
        ok: true,
        job,
        audioUrl: `/audio/${encodeURIComponent(path.basename(audioPath))}`,
      });
    } catch (error) {
      json(res, 502, { ok: false, job, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/create-job") {
    const body = await readJson(req);
    const job = createLineJob(body.text || "", config, undefined, {
      source: body.source || "manual",
      enableTts: body.enableTts,
    });
    if (!job.text) {
      json(res, 400, { ok: false, error: "请输入要发送的台词。" });
      return;
    }
    jobs.set(job.id, job);
    json(res, 200, { ok: true, job });
    return;
  }

  if (req.method === "POST" && pathname === "/api/publish") {
    const body = await readJson(req);
    const job = jobs.get(body.jobId);
    if (!job) {
      json(res, 404, {
        ok: false,
        error: "找不到这条台词任务，请重新发送。",
      });
      return;
    }
    const result = await publishJob(job);
    json(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/status") {
    json(res, 200, {
      ok: true,
      ai: aiOrchestrator.status(),
      scene: aiOrchestrator.sceneStatus(),
      secrets: secrets.status(),
      tts: publicAiTtsStatus(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/scene") {
    json(res, 200, { ok: true, scene: aiOrchestrator.sceneStatus() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/key") {
    const body = await readJson(req);
    secrets.setAiApiKey(body.apiKey || "");
    json(res, 200, { ok: true, secrets: secrets.status() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/search-credentials") {
    const body = await readJson(req);
    secrets.setTencentCloudCredentials({
      secretId: body.secretId || "",
      secretKey: body.secretKey || "",
    });
    json(res, 200, { ok: true, secrets: secrets.status() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/control") {
    const body = await readJson(req);
    if (body.action === "pause") {
      aiOrchestrator.stop();
      replyQueue.pause();
    }
    if (body.action === "resume") {
      if (config.ai.enabled) startAiServices();
      await replyQueue.resume();
    }
    if (body.action === "clear") replyQueue.clear();
    if (body.action === "stop") {
      stopAiServices();
      replyQueue.pause();
      replyQueue.clear();
    }
    json(res, 200, { ok: true, ai: aiOrchestrator.status() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/test-message") {
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    if (!text) {
      json(res, 400, { ok: false, error: "请输入要测试的消息。" });
      return;
    }
    const userName = String(body.userName || "测试观众").trim() || "测试观众";
    const event = {
      id: `local-test-${crypto.randomUUID()}`,
      kind: "danmaku",
      roomId: config.roomId,
      userId: `local-test-${userName}`,
      userName,
      text,
      source: "local-test",
      actionable: true,
      receivedAt: new Date().toISOString(),
    };
    await aiOrchestrator.onLiveEvent(event);
    json(res, 200, { ok: true, event, ai: aiOrchestrator.status() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/memory/summary") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    json(res, 200, {
      ok: true,
      memory: getAiMemorySnapshot({
        type: url.searchParams.get("type") || "",
        status: url.searchParams.get("status") || "",
      }),
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/ai/memory/summary") {
    const body = await readJson(req);
    aiMemory.setStreamSummary(body.summary || "", { source: "manual" });
    json(res, 200, { ok: true, memory: getAiMemorySnapshot() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/summary/generate") {
    try {
      const result = await generateMemorySummary();
      json(res, 200, { ok: true, result, memory: getAiMemorySnapshot() });
    } catch (error) {
      json(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/summary/clear") {
    aiMemory.setStreamSummary("", { source: "clear" });
    json(res, 200, { ok: true, memory: getAiMemorySnapshot() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/short-term/clear") {
    json(res, 200, {
      ok: true,
      result: aiMemory.clearConversationEvents(),
      memory: getAiMemorySnapshot(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/memory/long-term") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    json(res, 200, {
      ok: true,
      memories: aiMemory.listLongTermMemories({
        type: url.searchParams.get("type") || "",
        status: url.searchParams.get("status") || "",
        limit: url.searchParams.get("limit") || 200,
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/long-term") {
    try {
      const body = await readJson(req);
      const memory = aiMemory.upsertLongTermMemory({
        type: body.type,
        content: body.content,
        source: body.source || "manual",
        confidence: body.confidence ?? 1,
        importance: body.importance ?? 3,
        status: body.status || "active",
      });
      json(res, 200, { ok: true, memory });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "PUT" && pathname === "/api/ai/memory/long-term") {
    try {
      const body = await readJson(req);
      const memory = aiMemory.updateLongTermMemory(body.id, body);
      if (!memory) {
        json(res, 404, { ok: false, error: "Memory not found" });
        return;
      }
      json(res, 200, { ok: true, memory });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/ai/memory/long-term") {
    const body = await readJson(req);
    json(res, 200, {
      ok: true,
      result: aiMemory.deleteLongTermMemory(body.id),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/long-term/clear") {
    const body = await readJson(req);
    json(res, 200, {
      ok: true,
      result: aiMemory.clearLongTermMemories({ status: body.status || "" }),
      memory: getAiMemorySnapshot(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/memory/revisions") {
    json(res, 200, {
      ok: true,
      revisions: aiMemory.listMemoryRevisions({ limit: 50 }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/memory/revisions/restore") {
    const body = await readJson(req);
    const summary = aiMemory.restoreMemoryRevision(body.id);
    if (summary === null) {
      json(res, 404, { ok: false, error: "Memory revision not found" });
      return;
    }
    json(res, 200, { ok: true, summary, memory: getAiMemorySnapshot() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/memory") {
    json(res, 200, {
      ok: true,
      unclaimed: aiMemory.getUnclaimedMessages({ limit: 50 }),
      queue: replyQueue.status(),
      memory: getAiMemorySnapshot(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/ai/context") {
    json(res, 200, { ok: true, context: getAiContextSnapshot() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/preview-caption") {
    const body = await readJson(req);
    const previewText = String(body.text || "白框预览文字").trim();
    const caption = captions.publish(previewText, config);
    json(res, 200, { ok: true, caption });
    return;
  }

  if (req.method === "POST" && pathname === "/api/clear-caption") {
    json(res, 200, { ok: true, caption: captions.clear(config) });
    return;
  }

  json(res, 404, { ok: false, error: "Unknown API route" });
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/") {
      redirect(res, "/control");
      return;
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === "/control") {
      serveFile(res, path.join(PUBLIC_DIR, "control.html"));
      return;
    }
    if (pathname === "/memory") {
      serveFile(res, path.join(PUBLIC_DIR, "memory.html"));
      return;
    }
    if (pathname === "/caption") {
      serveFile(res, path.join(PUBLIC_DIR, "caption.html"));
      return;
    }
    if (pathname === "/dialogue") {
      serveFile(res, path.join(PUBLIC_DIR, "dialogue.html"));
      return;
    }
    if (pathname === "/log-overlay") {
      serveFile(res, path.join(PUBLIC_DIR, "log-overlay.html"));
      return;
    }
    if (pathname === "/audio-player") {
      serveFile(res, path.join(PUBLIC_DIR, "audio-player.html"));
      return;
    }
    if (pathname.startsWith("/public/")) {
      serveFile(res, path.join(PUBLIC_DIR, pathname.replace("/public/", "")));
      return;
    }
    if (pathname === "/asset/caption-image") {
      serveFile(res, config.captionImagePath);
      return;
    }
    if (pathname.startsWith("/audio/")) {
      serveFile(res, path.join(AUDIO_DIR, path.basename(pathname)));
      return;
    }
    if (req.method === "GET" && pathname === "/api/audio/test-tone") {
      binary(res, 200, createTestToneWav(), "audio/wav");
      return;
    }
    if (pathname.startsWith("/resource/reference/")) {
      const name = pathname.slice("/resource/reference/".length);
      try {
        serveFile(res, resourceLibrary.resolveReference(name));
      } catch (error) {
        json(res, 404, { ok: false, error: error.message });
      }
      return;
    }
    if (
      req.method === "POST" &&
      pathname === "/api/resources/import"
    ) {
      await handleResourceImport(req, res, url);
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    text(res, 404, "Not found");
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
migrateTtsConfig();
migrateCaptionConfig();

const server = http.createServer((req, res) => {
  handle(req, res);
});

server.listen(config.serverPort, "127.0.0.1", () => {
  console.log(
    `台词桥接工具已启动: http://127.0.0.1:${config.serverPort}/control`,
  );
  console.log(
    `直播姬白框浏览器源: http://127.0.0.1:${config.serverPort}/caption`,
  );
  console.log(`配置文件: ${CONFIG_PATH}`);

  if (config.ai.enabled) {
    startAiServices();
  }

  prepareTtsAssets()
    .then(() => {
      if (config.tts.autoStartApi) return ttsManager.start(config);
      return null;
    })
    .then((result) => {
      if (result) console.log("GPT-SoVITS API 已就绪。");
    })
    .catch((error) => {
      console.error(`GPT-SoVITS 自动启动失败: ${error.message}`);
    });
});

function shutdown() {
  stopAiServices();
  aiMemory.close();
  ttsManager.shutdown();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
