import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_CONFIG,
  buildDanmakuText,
  buildGradioTtsArgs,
  buildPublishPlan,
  buildTtsRequest,
  createCaptionEvent,
  normalizeConfig,
} from "../src/core.mjs";
import {
  CaptionAudioStore,
  CaptionStore,
  DialogueLogStore,
  createLineJob,
} from "../src/state.mjs";
import { ConfigStore } from "../src/config-store.mjs";
import { SecretStore } from "../src/secret-store.mjs";
import {
  buildApiConfigYaml,
  buildGradioLaunchEnvironment,
  resolveManagedTtsPaths,
  validateReferenceDuration,
} from "../src/tts-manager.mjs";
import {
  ResourceLibrary,
  resolveResourcePaths,
  uniqueDestinationName,
} from "../src/resource-library.mjs";
import {
  AudioEditor,
  buildTrimmedFileName,
  validateTrimRange,
} from "../src/audio-editor.mjs";
import {
  cleanFontFamilyName,
  normalizeFontFamilies,
} from "../src/font-library.mjs";
import { createTestToneWav } from "../src/test-tone.mjs";
import { fitFontSize } from "../src/public/caption-layout.js";
import {
  AudioRouter,
  buildAudioRoutes,
} from "../src/public/audio-router.js";
import { AudioPlaybackGate } from "../src/public/audio-playback-gate.js";
import { AudioPlaybackController } from "../src/public/audio-playback-controller.js";
import { readWavDurationSeconds } from "../src/audio-duration.mjs";
import {
  TtsClient,
  validateAuxiliaryReferences,
} from "../src/tts-client.mjs";
import { AiMemoryStore } from "../src/ai-memory.mjs";
import { AiChatClient } from "../src/ai-client.mjs";
import {
  buildReplyMessages,
  parseReplySegments,
  splitLongSegment,
} from "../src/ai-reply.mjs";
import { ReplyQueue } from "../src/reply-queue.mjs";
import {
  BiliReceiver,
  buildBiliPacket,
  decodeBiliPackets,
  extractPageChatItemsFromDocument,
  normalizeBiliDanmaku,
  normalizeBiliLiveEvent,
} from "../src/bili-receiver.mjs";
import {
  buildDirectorMessages,
  parseDirectorDecision,
} from "../src/ai-director.mjs";
import { AiOrchestrator } from "../src/ai-orchestrator.mjs";
import {
  attachEventTimeContext,
  buildCurrentTimeContext,
  filterConversationEventsForAi,
  visibleContextLimit,
} from "../src/ai-context.mjs";
import { LiveSceneState } from "../src/live-scene.mjs";
import { MusicCollaborator } from "../src/music-collaborator.mjs";
import { BiliMusicLogStore } from "../src/bili-music-log-store.mjs";
import {
  resolveVoiceMeeterRoute,
  VoiceMeeterRouter,
} from "../src/voicemeeter-router.mjs";
import { resolveTtsProfile } from "../src/tts-profile-resolver.mjs";

test("Windows launcher waits for readiness and keeps startup failures visible", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const launcher = fs.readFileSync(
    path.join(root, "start_dialogue_bridge.bat"),
    "utf8",
  );
  const readinessHelper = fs.readFileSync(
    path.join(root, "src", "open-control-when-ready.ps1"),
    "utf8",
  );

  assert.match(launcher, /node\.exe src\\server\.mjs/i);
  assert.doesNotMatch(launcher, /npm run dialogue-bridge/i);
  assert.match(launcher, /open-control-when-ready\.ps1/i);
  assert.match(launcher, /\/api\/status/i);
  assert.match(launcher, /pause/i);
  assert.match(readinessHelper, /\$StatusUrl/i);
  assert.match(readinessHelper, /Invoke-RestMethod/i);
  assert.match(readinessHelper, /Start-Process/i);
});

test("server publishes jobs through shared publish helper", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(
    path.join(root, "src", "server.mjs"),
    "utf8",
  );

  assert.match(server, /async function publishJob\(job\)/);
  assert.match(server, /job\.publish\?\.enableCaption/);
  assert.match(server, /const result = await publishJob\(job\)/);
});

test("server resolves TTS and Bilibili policy from each line source", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");

  assert.match(server, /resolveTtsProfile/);
  assert.match(server, /ttsClient\.synthesize\(job, resolveTtsProfile/);
  assert.match(server, /buildPublishPlan\(config, job\.danmakuText, \{\s*source/);
  assert.match(server, /source:\s*body\.source \|\| "manual"/);
  assert.match(server, /enableTts:\s*body\.enableTts/);
});

test("server skips reference metadata migration until a reference audio file is selected", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");

  assert.match(
    server,
    /if \(currentSelection\.refAudioPath && !audioEditor\.getMetadata\(referenceName\)\)/,
  );
});

test("server exposes AI control and secret routes", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(
    path.join(root, "src", "server.mjs"),
    "utf8",
  );

  assert.match(server, /\/api\/ai\/status/);
  assert.match(server, /\/api\/ai\/control/);
  assert.match(server, /\/api\/ai\/key/);
  assert.match(server, /\/api\/ai\/search-credentials/);
  assert.match(server, /\/api\/ai\/memory/);
  assert.match(server, /SecretStore/);
  assert.match(server, /AiOrchestrator/);
});

test("server publishes idle AI output and exposes live scene status", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(
    path.join(root, "src", "server.mjs"),
    "utf8",
  );

  assert.match(server, /ai-idle/);
  assert.match(server, /\/api\/ai\/scene/);
  assert.match(server, /scene:\s*aiOrchestrator\.sceneStatus\(\)/);
});

test("AI offline test chat route injects a local danmaku event", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(
    path.join(root, "src", "server.mjs"),
    "utf8",
  );

  assert.match(server, /\/api\/ai\/test-message/);
  assert.match(server, /kind:\s*"danmaku"/);
  assert.match(server, /source:\s*"local-test"/);
  assert.match(server, /aiOrchestrator\.onLiveEvent\(event\)/);
});

test("AI offline test replies keep local test source and skip real danmaku", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const orchestrator = fs.readFileSync(
    path.join(root, "src", "ai-orchestrator.mjs"),
    "utf8",
  );

  assert.match(orchestrator, /replySource[\s\S]*\?\s*"ai-test"/);
  assert.match(orchestrator, /source:\s*replySource/);
  assert.match(server, /source:\s*segment\.source\s*\|\|\s*"ai"/);
  assert.match(server, /job\.publish\?\.source === "ai-test"/);
  assert.match(server, /job\.publish\?\.source !== "ai-test"/);
});

test("control page contains AI auto reply controls", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(html, /aiSettingsForm/);
  assert.match(html, /aiStatusPanel/);
  assert.match(html, /aiPersona/);
  assert.match(html, /name="ai\.provider"/);
  assert.match(html, /ai\.tools\.enabled/);
  assert.match(html, /ai\.tools\.webSearch\.endpoint/);
  assert.match(html, /aiApiKey/);
  assert.match(html, /aiSearchKeyForm/);
  assert.match(html, /tencentSecretId/);
  assert.match(html, /tencentSecretKey/);
  assert.match(js, /\/api\/ai\/status/);
  assert.match(js, /\/api\/ai\/control/);
  assert.match(js, /\/api\/ai\/key/);
  assert.match(js, /\/api\/ai\/search-credentials/);
});

test("control page contains AI context viewer with offline test composer", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(html, /aiContextPanel/);
  assert.match(html, /aiContextClock/);
  assert.match(html, /aiContextMessages/);
  assert.match(html, /aiContextSettingsForm/);
  assert.match(html, /ai\.memorySummaryInterval/);
  assert.match(html, /ai\.replyAudioGapSeconds/);
  assert.match(
    html,
    /name="ai\.replyAudioGapSeconds"[^>]*type="number"[^>]*min="-0\.5"[^>]*step="0\.1"/,
  );
  assert.match(html, /aiTestUserName/);
  assert.match(html, /aiTestMessage/);
  assert.match(html, /sendAiTestMessageButton/);
  assert.doesNotMatch(html, /id="aiTestChatPanel"/);
  assert.match(js, /refreshAiContext/);
  assert.match(js, /sendAiTestMessage/);
  assert.match(js, /currentTime/);
  assert.match(js, /\/api\/ai\/test-message/);
  assert.match(js, /\/api\/ai\/context/);
});

test("control page exposes live scene autonomy settings and status", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(html, /aiSceneSettingsForm/);
  assert.match(html, /name="ai\.scene\.enabled"/);
  assert.match(html, /name="ai\.scene\.vision\.enabled"/);
  assert.match(html, /name="ai\.scene\.vision\.displayId"/);
  assert.match(html, /name="ai\.scene\.idleMinSeconds"/);
  assert.match(html, /name="ai\.scene\.idleCooldownMinSeconds"/);
  assert.match(html, /name="ai\.scene\.idleCooldownMaxSeconds"/);
  assert.match(html, /aiSceneStatus/);
  assert.match(js, /\/api\/ai\/scene/);
});

test("buildDanmakuText sends only the first configured characters", () => {
  const text = "一二三四五六七八九十十一十二十三十四十五十六十七十八十九二十再多一点";
  assert.equal(buildDanmakuText(text, 10), "一二三四五六七八九十");
});

test("buildDanmakuText keeps short text unchanged and trims whitespace", () => {
  assert.equal(buildDanmakuText("  雪风智乃测试  ", 40), "雪风智乃测试");
});

test("normalizeConfig keeps caption visible indefinitely when duration is zero", () => {
  const config = normalizeConfig({ captionDurationSeconds: 0 });
  assert.equal(config.captionDurationSeconds, 0);
  assert.equal(config.captionAnimation, "typewriter");
});

test("normalizeConfig defaults to safe publishing and system audio output", () => {
  const config = normalizeConfig();

  assert.equal(config.sendRealDanmaku, false);
  assert.deepEqual(config.publish, {
    enableTts: true,
    enableCaption: true,
  });
  assert.deepEqual(config.ai, {
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
    contextEventKinds: {
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
    },
    tools: {
      enabled: true,
      autoUseTools: true,
      dailySearchLimit: 0,
      maxSearchesPerReply: 1,
      webSearch: {
        enabled: true,
        provider: "tencent-wsa-mcp",
        transport: "streamable_http",
        endpoint: "",
        maxResults: 5,
      },
    },
    scene: {
      enabled: true,
      idleMinSeconds: 120,
      idleCooldownMinSeconds: 120,
      idleCooldownMaxSeconds: 300,
      vision: {
        enabled: false,
        targetType: "display",
        displayId: "",
        rollingWindowSeconds: 600,
        maxCapturesPerWindow: 10,
        verified: false,
      },
    },
  });
  assert.deepEqual(config.audioOutput, {
    mode: "system",
    volume: 1,
    primaryDeviceId: "",
    primaryDeviceLabel: "",
    monitorDeviceId: "",
    monitorDeviceLabel: "",
  });
  assert.equal(config.captionTextBox.minimumFontSize, 18);
  assert.deepEqual(config.dialogueLog, {
    x: 1305,
    y: 680,
    width: 430,
    height: 360,
    fontSize: 24,
    maxLines: 5,
    itemMinHeight: 48,
    gap: 10,
  });
  assert.deepEqual(config.tts.auxRefAudioPaths, []);
});

test("normalizeConfig adds bounded BiliNCM and VoiceMeeter defaults", () => {
  const config = normalizeConfig({
    music: {
      biliNcm: {
        baseUrl: "https://example.com",
        pollIntervalSeconds: 0,
      },
      voiceMeeter: {
        inputStrip: "  Strip[2]  ",
        remoteDllPath: " C:/vm.dll ",
      },
      outputMode: "media_only",
    },
  });

  assert.deepEqual(config.music, {
    enabled: false,
    biliNcm: {
      baseUrl: "http://127.0.0.1:5555",
      executablePath: "",
      pollIntervalSeconds: 2,
    },
    voiceMeeter: {
      enabled: false,
      remoteDllPath: "C:/vm.dll",
      inputStrip: "Strip[2]",
    },
    outputMode: "media_only",
  });
});

test("MusicCollaborator normalizes BiliNCM state from its local data API", async () => {
  const collaborator = new MusicCollaborator({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          current: {
            Id: 100,
            SongName: "Song",
            ArtistName: "Artist",
            OrderedBy: "viewer",
          },
          queue: [{ Id: 101, SongName: "Next" }],
          accepting: true,
          playing: false,
          status: "ready",
          cdpConnected: true,
        };
      },
    }),
  });

  const state = await collaborator.refresh("http://127.0.0.1:5555");
  assert.equal(state.connected, true);
  assert.equal(state.current.title, "Song");
  assert.equal(state.queue.length, 1);
  assert.equal(state.cdpConnected, true);
});

test("MusicCollaborator includes raw BiliNCM backend logs when the endpoint is available", async () => {
  const collaborator = new MusicCollaborator({
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        if (new URL(url).pathname === "/api/logs") {
          return [
            { Time: "16:19:34", Color: "Green", Message: "CDP 注入成功" },
            { Time: "16:19:36", Color: "Magenta", Message: "收到点歌" },
          ];
        }
        return { current: null, queue: [], cdpConnected: true };
      },
    }),
  });

  const state = await collaborator.refresh("http://127.0.0.1:5555");

  assert.equal(state.logsAvailable, true);
  assert.deepEqual(state.logs, [
    { time: "16:19:34", color: "Green", message: "CDP 注入成功" },
    { time: "16:19:36", color: "Magenta", message: "收到点歌" },
  ]);
});

test("MusicCollaborator rejects non-loopback endpoints and unsupported actions", async () => {
  const collaborator = new MusicCollaborator();

  await assert.rejects(
    collaborator.refresh("https://example.com"),
    /本机 BiliNCM 地址/,
  );
  await assert.rejects(
    collaborator.queueAction("http://127.0.0.1:5555", { action: "shell" }),
    /不支持的点歌队列操作/,
  );
});

test("VoiceMeeterRouter maps each music output mode to A1 and B1", () => {
  assert.deepEqual(resolveVoiceMeeterRoute("stream_only"), { A1: 0, B1: 1 });
  assert.deepEqual(resolveVoiceMeeterRoute("stream_and_media"), { A1: 1, B1: 1 });
  assert.deepEqual(resolveVoiceMeeterRoute("media_only"), { A1: 1, B1: 0 });
});

test("VoiceMeeterRouter rejects an apply response whose read-back differs", async () => {
  const router = new VoiceMeeterRouter({
    runHelper: async () => ({ ok: true, A1: 0, B1: 1 }),
  });

  await assert.rejects(
    router.apply({ mode: "stream_and_media", inputStrip: "Strip[0]" }),
    /VoiceMeeter 未确认应用输出模式/,
  );
});

test("VoiceMeeter helper embeds Windows DLL paths as C# verbatim strings", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const helper = fs.readFileSync(
    path.join(root, "tools", "voicemeeter-remote.ps1"),
    "utf8",
  );

  assert.match(helper, /\.Replace\('"', '""'\)/);
  assert.match(helper, /\[DllImport\(@"\$escapedDllPath"/);
});

test("server exposes isolated BiliNCM and VoiceMeeter collaboration routes", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");

  assert.match(server, /new MusicCollaborator/);
  assert.match(server, /new VoiceMeeterRouter/);
  assert.match(server, /\/api\/music\/status/);
  assert.match(server, /\/api\/music\/start/);
  assert.match(server, /\/api\/music\/queue-action/);
  assert.match(server, /\/api\/music\/output-mode/);
});

test("control page exposes BiliNCM collaboration and three VoiceMeeter modes", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(html, /musicCollaborationForm/);
  assert.match(html, /musicOutputModeStreamOnly/);
  assert.match(html, /musicOutputModeStreamAndMedia/);
  assert.match(html, /musicOutputModeMediaOnly/);
  assert.match(html, /musicCurrentSong/);
  assert.match(html, /musicQueueList/);
  assert.match(js, /refreshMusicCollaboration/);
  assert.match(js, /\/api\/music\/output-mode/);
});

test("control page embeds audio playback and source-specific output controls", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(html, /manualEnableTts/);
  assert.match(html, /biliDanmaku\.manualEnabled/);
  assert.match(html, /biliDanmaku\.aiEnabled/);
  assert.match(html, /speakerLabels\.manual/);
  assert.match(html, /speakerLabels\.ai/);
  assert.match(html, /audioPlaybackUnlockButton/);
  assert.match(html, /aiGptModelSelect/);
  assert.match(html, /dialogueUrl/);
  assert.match(html, /logOverlayUrl/);
  assert.match(html, /白框与生成语音使用同一条台词/);
  assert.doesNotMatch(html, /延迟后显示白框/);
  assert.doesNotMatch(html, /name="ttsDelaySeconds"/);
  assert.match(js, /AudioPlaybackController/);
  assert.match(js, /audioPlaybackController\.start\(\)/);
  assert.match(js, /enableTts: false/);
  assert.match(js, /enableTts: true/);
});

test("normalizeConfig adds bounded live scene defaults", () => {
  const config = normalizeConfig({
    ai: {
      scene: {
        idleMinSeconds: 0,
        idleCooldownMinSeconds: 280,
        idleCooldownMaxSeconds: 10,
        vision: {
          enabled: true,
          targetType: "window",
          displayId: " DISPLAY1 ",
          rollingWindowSeconds: 0,
          maxCapturesPerWindow: 0,
          verified: true,
        },
      },
    },
  });

  assert.deepEqual(config.ai.scene, {
    enabled: true,
    idleMinSeconds: 120,
    idleCooldownMinSeconds: 280,
    idleCooldownMaxSeconds: 280,
    vision: {
      enabled: true,
      targetType: "display",
      displayId: "DISPLAY1",
      rollingWindowSeconds: 600,
      maxCapturesPerWindow: 10,
      verified: false,
    },
  });
});

async function loadLiveSceneModule() {
  return import("../src/live-scene.mjs").catch((error) => ({ error }));
}

test("LiveSceneState emits one idle check only after human silence", async () => {
  const module = await loadLiveSceneModule();
  assert.equal(module.error, undefined);
  assert.equal(typeof module.LiveSceneState, "function");

  let currentTime = 0;
  const scene = new module.LiveSceneState({ now: () => currentTime, random: () => 0 });
  const config = normalizeConfig({
    ai: {
      scene: {
        idleMinSeconds: 120,
        idleCooldownMinSeconds: 120,
        idleCooldownMaxSeconds: 120,
      },
    },
  });
  const queue = { status: () => ({ busy: false, queuedSegments: 0 }) };

  scene.noteInteraction({ kind: "danmaku" });
  assert.equal(scene.takeIdleCheck({ config, queue }), null);

  currentTime = 120_000;
  assert.ok(scene.takeIdleCheck({ config, queue }));
  assert.equal(scene.takeIdleCheck({ config, queue }), null);
  assert.equal(scene.status().silenceSeconds, 120);
  assert.equal(scene.status().nextIdleCheckAt, "1970-01-01T00:04:00.000Z");
});

test("LiveSceneState keeps verified display reads inside the rolling quota", async () => {
  const module = await loadLiveSceneModule();
  assert.equal(module.error, undefined);
  assert.equal(typeof module.LiveSceneState, "function");

  let currentTime = 0;
  const scene = new module.LiveSceneState({ now: () => currentTime });
  const config = normalizeConfig({
    ai: {
      scene: {
        vision: {
          enabled: true,
          displayId: "DISPLAY1",
          rollingWindowSeconds: 600,
          maxCapturesPerWindow: 2,
        },
      },
    },
  });

  assert.equal(scene.requestScreenRead({ config }), null);
  scene.setVisionVerified(true);
  assert.deepEqual(scene.requestScreenRead({ config }), {
    displayId: "DISPLAY1",
    requestedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.ok(scene.requestScreenRead({ config }));
  assert.equal(scene.requestScreenRead({ config }), null);

  scene.recordScreenSummary({
    summary: "Night city game scene",
    displayId: "DISPLAY1",
  });
  assert.equal(scene.status().vision.lastSummary, "Night city game scene");
  assert.equal("image" in scene.status().vision, false);
  assert.equal(scene.status().vision.usedCaptures, 2);
});

test("normalizeConfig coerces publish and AI overrides", () => {
  const config = normalizeConfig({
    publish: { enableTts: 0, enableCaption: "yes" },
    ai: {
      enabled: "true",
      directorEnabled: 0,
      provider: "anthropic",
      baseUrl: " https://api.deepseek.com/v1/ ",
      model: " deepseek-v4-pro ",
      thinkingLevel: "max",
      requestTimeoutSeconds: -10,
      persona: "  persona text  ",
      contextLimit: "5.9",
      localHistoryLimit: "20.2",
      memorySummaryInterval: "12.9",
      replyAudioGapSeconds: "1.25",
      contextEventKinds: { danmaku: false, gift: 1, unknown: true },
      tools: {
        enabled: false,
        autoUseTools: false,
        dailySearchLimit: "7.2",
        maxSearchesPerReply: "2.8",
        webSearch: {
          enabled: false,
          provider: "tencent-wsa-mcp",
          transport: "streamable_http",
          endpoint: " https://mcp.example.test ",
          maxResults: "9.9",
        },
      },
    },
  });

  assert.deepEqual(config.publish, {
    enableTts: false,
    enableCaption: true,
  });
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.directorEnabled, false);
  assert.equal(config.ai.provider, "anthropic");
  assert.equal(config.ai.baseUrl, "https://api.deepseek.com/v1/");
  assert.equal(config.ai.model, "deepseek-v4-pro");
  assert.equal(config.ai.directorThinkingEnabled, true);
  assert.equal(config.ai.replyThinkingEnabled, true);
  assert.equal(config.ai.thinkingLevel, "max");
  assert.equal(config.ai.requestTimeoutSeconds, 120);
  assert.equal(config.ai.persona, "persona text");
  assert.equal(config.ai.contextLimit, 5);
  assert.equal(config.ai.localHistoryLimit, 20);
  assert.equal(config.ai.memorySummaryInterval, 12);
  assert.equal(config.ai.replyAudioGapSeconds, 1.25);
  assert.equal(config.ai.contextEventKinds.danmaku, false);
  assert.equal(config.ai.contextEventKinds.gift, true);
  assert.equal(config.ai.contextEventKinds.unknown, undefined);
  assert.equal(config.ai.tools.enabled, false);
  assert.equal(config.ai.tools.autoUseTools, false);
  assert.equal(config.ai.tools.dailySearchLimit, 7);
  assert.equal(config.ai.tools.maxSearchesPerReply, 2);
  assert.equal(config.ai.tools.webSearch.enabled, false);
  assert.equal(config.ai.tools.webSearch.endpoint, "https://mcp.example.test");
  assert.equal(config.ai.tools.webSearch.maxResults, 9);
});

test("normalizeConfig allows a small negative AI reply audio gap", () => {
  assert.equal(
    normalizeConfig({ ai: { replyAudioGapSeconds: "-0.3" } }).ai
      .replyAudioGapSeconds,
    -0.3,
  );
  assert.equal(
    normalizeConfig({ ai: { replyAudioGapSeconds: "-0.75" } }).ai
      .replyAudioGapSeconds,
    -0.5,
  );
  assert.equal(
    normalizeConfig({ ai: { replyAudioGapSeconds: "not-a-number" } }).ai
      .replyAudioGapSeconds,
    DEFAULT_CONFIG.ai.replyAudioGapSeconds,
  );
});

test("AI context filters event kinds and keeps the newest visible entries", () => {
  const config = normalizeConfig({
    ai: {
      contextLimit: 2,
      contextEventKinds: {
        danmaku: true,
        gift: false,
        ai_reply: true,
      },
    },
  });
  const events = [
    { id: "1", kind: "danmaku", text: "first" },
    { id: "2", kind: "gift", text: "gift" },
    { id: "3", kind: "ai_reply", text: "reply" },
    { id: "4", kind: "danmaku", text: "last" },
  ];

  assert.equal(visibleContextLimit(config), 2);
  assert.deepEqual(
    filterConversationEventsForAi(config, events).map((event) => event.id),
    ["3", "4"],
  );
});

test("AI context adds current time and per-event timing for live awareness", () => {
  const now = new Date("2026-06-18T10:30:00.000Z");
  const currentTime = buildCurrentTimeContext({ now, timeZone: "Asia/Shanghai" });
  const events = attachEventTimeContext(
    [
      {
        id: "time-1",
        kind: "danmaku",
        text: "刚刚聊到这里",
        createdAt: "2026-06-18T10:28:30.000Z",
      },
    ],
    { now, timeZone: "Asia/Shanghai" },
  );

  assert.equal(currentTime.timeZone, "Asia/Shanghai");
  assert.equal(currentTime.localDateTime, "2026-06-18 18:30:00");
  assert.equal(currentTime.dayPart, "晚上");
  assert.equal(events[0].localTime, "18:28:30");
  assert.equal(events[0].ageSeconds, 90);
  assert.equal(events[0].ageLabel, "1分钟前");
});

test("server exposes AI context snapshot route", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const orchestrator = fs.readFileSync(
    path.join(root, "src", "ai-orchestrator.mjs"),
    "utf8",
  );

  assert.match(server, /\/api\/ai\/context/);
  assert.match(server, /getAiContextSnapshot/);
  assert.match(orchestrator, /readVisibleAiContext/);
  assert.doesNotMatch(orchestrator, /LIVE_CONTEXT_LIMIT/);
});

test("server exposes memory management page and APIs", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "memory.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "memory.js"),
    "utf8",
  );

  assert.match(server, /pathname === "\/memory"/);
  assert.match(server, /\/api\/ai\/memory\/summary/);
  assert.match(server, /\/api\/ai\/memory\/summary\/generate/);
  assert.match(server, /\/api\/ai\/memory\/long-term/);
  assert.match(server, /\/api\/ai\/memory\/revisions/);
  assert.match(html, /memorySummary/);
  assert.match(html, /longTermMemoryList/);
  assert.match(html, /pendingMemoryList/);
  assert.match(js, /refreshMemory/);
  assert.match(js, /restoreMemoryRevision/);
});

test("MCP search helper parses tool decisions and normalizes Tencent search results", async () => {
  const {
    buildToolDecisionMessages,
    detectMcpTransportType,
    parseToolDecision,
    normalizeMcpSearchResult,
    McpSearchClient,
  } = await import("../src/mcp-search.mjs");

  const messages = buildToolDecisionMessages({
    selectedMessages: [{ userName: "viewer-a", text: "重庆天气怎么样" }],
    recentEvents: [],
    shortTermSummary: "正在测试联网搜索。",
  });
  const decision = parseToolDecision(
    JSON.stringify({
      useTool: true,
      toolName: "web_search",
      query: "重庆 今日 天气",
      reason: "观众询问实时天气。",
      rememberShortTerm: true,
    }),
  );
  const normalized = normalizeMcpSearchResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              title: "重庆天气预报",
              url: "https://example.test/weather",
              snippet: "重庆今天多云。",
              source: "天气站",
            },
          ],
        }),
      },
    ],
  });
  const calls = [];
  const client = new McpSearchClient({
    endpoint: "https://mcp.example.test",
    secretId: "secret-id",
    secretKey: "secret-key",
    createClient: async () => ({
      callTool: async (request) => {
        calls.push(request);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                Response: {
                  Query: "重庆天气",
                  Pages: normalized.map((item) =>
                    JSON.stringify({
                      title: item.title,
                      url: item.url,
                      passage: item.snippet,
                      site: item.source,
                      date: item.publishedAt,
                    }),
                  ),
                },
              }),
            },
          ],
        };
      },
      close: async () => {},
    }),
  });
  const search = await client.search({ query: "重庆天气", maxResults: 5 });

  assert.equal(messages[0].role, "system");
  assert.equal(decision.useTool, true);
  assert.equal(decision.query, "重庆 今日 天气");
  assert.equal(decision.rememberShortTerm, true);
  assert.equal(normalized[0].title, "重庆天气预报");
  assert.equal(
    detectMcpTransportType({
      endpoint: "https://mcp-api.tencent-cloud.com/sse/abc123",
      transport: "streamable_http",
    }),
    "sse",
  );
  assert.equal(calls[0].name, "wsa-SearchPro");
  assert.equal(calls[0].arguments.Query, "重庆天气");
  assert.equal(calls[0].arguments.query, undefined);
  assert.equal(search.results[0].snippet, "重庆今天多云。");
});

test("buildPublishPlan skips Bilibili while preserving caption publishing", () => {
  assert.deepEqual(
    buildPublishPlan(
      normalizeConfig({ sendRealDanmaku: false }),
      "测试弹幕",
    ),
    {
      shouldSend: false,
      text: "测试弹幕",
      reason: "真实弹幕已关闭",
    },
  );
  assert.equal(
    buildPublishPlan(
      normalizeConfig({ sendRealDanmaku: true }),
      "测试弹幕",
    ).shouldSend,
    true,
  );
});

test("normalizeConfig gives each source labels and migrates legacy real danmaku setting", () => {
  const legacy = normalizeConfig({ sendRealDanmaku: true });

  assert.deepEqual(legacy.speakerLabels, {
    manual: "主播",
    ai: "雪风",
  });
  assert.deepEqual(legacy.biliDanmaku, {
    manualEnabled: true,
    aiEnabled: true,
  });
  assert.equal(buildPublishPlan(legacy, "人工台词", { source: "manual" }).shouldSend, true);
  assert.equal(buildPublishPlan(legacy, "AI 台词", { source: "ai" }).shouldSend, true);

  const sourceSpecific = normalizeConfig({
    sendRealDanmaku: true,
    biliDanmaku: { manualEnabled: false, aiEnabled: true },
  });
  assert.equal(
    buildPublishPlan(sourceSpecific, "人工台词", { source: "manual" }).shouldSend,
    false,
  );
  assert.equal(
    buildPublishPlan(sourceSpecific, "AI 台词", { source: "ai" }).shouldSend,
    true,
  );
  assert.equal(
    buildPublishPlan(sourceSpecific, "本地测试", { source: "ai-test" })
      .shouldSend,
    false,
  );
});

test("createCaptionEvent binds text and the image container to the same visibility event", () => {
  const config = normalizeConfig({
    captionDurationSeconds: 5,
    captionFadeSeconds: 0.75,
    captionAnimation: "instant",
  });
  const event = createCaptionEvent("这是白框里的全文", config, 42);

  assert.deepEqual(event, {
    id: 42,
    text: "这是白框里的全文",
    visible: true,
    animation: "instant",
    durationSeconds: 5,
    fadeSeconds: 0.75,
    textBox: DEFAULT_CONFIG.captionTextBox,
    speakerLabelBox: DEFAULT_CONFIG.captionSpeakerLabelBox,
    source: "manual",
    speakerLabel: "主播",
  });
});

test("buildTtsRequest maps control settings to GPT-SoVITS api_v2 payload", () => {
  const config = normalizeConfig({
    tts: {
      refAudioPath: "D:/ref.wav",
      auxRefAudioPaths: [
        "D:/aux-1.wav",
        "D:/ref.wav",
        "D:/aux-1.wav",
        "D:/aux-2.wav",
      ],
      promptText: "参考文本",
      promptLang: "ja",
      textLang: "zh",
      topK: 15,
      topP: 0.8,
      temperature: 0.9,
      speedFactor: 1.1,
      textSplitMethod: "cut5",
      fragmentInterval: 0.25,
      sampleSteps: 8,
    },
  });

  assert.deepEqual(buildTtsRequest("测试语音", config), {
    text: "测试语音",
    text_lang: "all_zh",
    ref_audio_path: "D:/ref.wav",
    aux_ref_audio_paths: ["D:/aux-1.wav", "D:/aux-2.wav"],
    prompt_text: "参考文本",
    prompt_lang: "all_ja",
    top_k: 15,
    top_p: 0.8,
    temperature: 0.9,
    text_split_method: "cut5",
    batch_size: 1,
    batch_threshold: 0.75,
    split_bucket: true,
    speed_factor: 1.1,
    fragment_interval: 0.25,
    seed: -1,
    media_type: "wav",
    streaming_mode: false,
    parallel_infer: true,
    repetition_penalty: 1.35,
    sample_steps: 8,
    super_sampling: false,
    overlap_length: 2,
    min_chunk_length: 16,
  });
});

test("buildGradioTtsArgs maps short language codes to GPT-SoVITS Gradio labels", () => {
  const config = normalizeConfig({
    tts: {
      refAudioPath: "D:/ref.wav",
      auxRefAudioPaths: [
        "D:/aux-1.wav",
        "D:/ref.wav",
        "D:/aux-1.wav",
        "D:/aux-2.mp3",
      ],
      promptText: "参考文本",
      promptLang: "ja",
      textLang: "zh",
      topK: 15,
      topP: 0.8,
      temperature: 0.9,
      speedFactor: 1.1,
      textSplitMethod: "cut1",
      fragmentInterval: 0.25,
      sampleSteps: 8,
    },
  });

  assert.deepEqual(buildGradioTtsArgs("测试语音", config), [
    "D:/ref.wav",
    "参考文本",
    "日文",
    "测试语音",
    "中文",
    "凑四句一切",
    15,
    0.8,
    0.9,
    false,
    1.1,
    false,
    ["D:/aux-1.wav", "D:/aux-2.mp3"],
    8,
    false,
    0.25,
    true,
  ]);
});

test("TtsClient synthesizes through the original Gradio helper", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-gradio-client-"));
  const primary = path.join(directory, "primary.wav");
  const auxiliary = path.join(directory, "auxiliary.mp3");
  fs.writeFileSync(primary, "primary");
  fs.writeFileSync(auxiliary, "auxiliary");
  const config = normalizeConfig({
    tts: {
      gradioEndpoint: "http://127.0.0.1:9872",
      pythonPath: "D:/GPT-SoVITS/runtime/python.exe",
      refAudioPath: primary,
      auxRefAudioPaths: [auxiliary],
      promptText: "参考文本",
      promptLang: "ja",
      textLang: "ja",
    },
  });
  let captured;
  const manager = {
    async ensureReady() {
      return { ok: true };
    },
    async status() {
      return { ok: true };
    },
  };
  const client = new TtsClient({
    audioDirectory: path.join(directory, "output"),
    manager,
    helperPath: "C:/bridge/gpt_sovits_gradio_helper.py",
    helperRunner: async (request) => {
      captured = request;
      fs.mkdirSync(path.dirname(request.payload.outputPath), {
        recursive: true,
      });
      fs.writeFileSync(request.payload.outputPath, "wav");
    },
  });

  const outputPath = await client.synthesize(
    { id: "job-1", text: "雪風は元気です。" },
    config,
  );

  assert.equal(
    captured.pythonPath,
    "D:/GPT-SoVITS/runtime/python.exe",
  );
  assert.equal(
    captured.helperPath,
    "C:/bridge/gpt_sovits_gradio_helper.py",
  );
  assert.equal(captured.payload.endpoint, "http://127.0.0.1:9872");
  assert.equal(captured.payload.args[3], "雪風は元気です。");
  assert.equal(captured.payload.args[4], "日文");
  assert.deepEqual(captured.payload.args[12], [auxiliary]);
  assert.equal(outputPath, captured.payload.outputPath);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "wav");
});

test("all GPT-SoVITS v2 language choices map one-to-one for API and Gradio", () => {
  const languageCases = [
    ["zh", "all_zh", "中文"],
    ["en", "en", "英文"],
    ["ja", "all_ja", "日文"],
    ["yue", "all_yue", "粤语"],
    ["ko", "all_ko", "韩文"],
    ["zh_en", "zh", "中英混合"],
    ["ja_en", "ja", "日英混合"],
    ["yue_en", "yue", "粤英混合"],
    ["ko_en", "ko", "韩英混合"],
    ["auto", "auto", "多语种混合"],
    ["auto_yue", "auto_yue", "多语种混合(粤语)"],
  ];

  for (const [storedValue, apiValue, gradioLabel] of languageCases) {
    const config = normalizeConfig({
      tts: {
        refAudioPath: "D:/ref.wav",
        promptText: "参考文本",
        promptLang: storedValue,
        textLang: storedValue,
      },
    });
    const request = buildTtsRequest("测试语音", config);
    const gradioArgs = buildGradioTtsArgs("测试语音", config);

    assert.equal(request.prompt_lang, apiValue, storedValue);
    assert.equal(request.text_lang, apiValue, storedValue);
    assert.equal(gradioArgs[2], gradioLabel, storedValue);
    assert.equal(gradioArgs[4], gradioLabel, storedValue);
  }
});

test("target and reference language selectors expose all GPT-SoVITS v2 choices", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const expectedValues = [
    "zh",
    "en",
    "ja",
    "yue",
    "ko",
    "zh_en",
    "ja_en",
    "yue_en",
    "ko_en",
    "auto",
    "auto_yue",
  ];
  const referenceSelect = html.match(
    /<select id="referenceLanguage">([\s\S]*?)<\/select>/,
  )?.[1];
  const targetSelect = html.match(
    /<select name="tts\.textLang">([\s\S]*?)<\/select>/,
  )?.[1];

  assert.ok(referenceSelect);
  assert.ok(targetSelect);
  for (const value of expectedValues) {
    assert.match(referenceSelect, new RegExp(`value="${value}"`), value);
    assert.match(targetSelect, new RegExp(`value="${value}"`), value);
  }
});

test("createLineJob keeps full text but limits the real danmaku copy", () => {
  const config = normalizeConfig({ danmakuMaxLength: 4, ttsDelaySeconds: 3 });
  const job = createLineJob("  一二三四五六  ", config, "job-1");

  assert.equal(job.id, "job-1");
  assert.equal(job.text, "一二三四五六");
  assert.equal(job.danmakuText, "一二三四");
  assert.equal(job.delaySeconds, 3);
});

test("createLineJob records publish toggles and source", () => {
  const config = normalizeConfig({
    publish: { enableTts: 0, enableCaption: "yes" },
  });
  const job = createLineJob("hello", config, "job-2", {
    source: "ai-director",
  });

  assert.deepEqual(job.publish, {
    enableTts: false,
    enableCaption: true,
    source: "ai-director",
  });
});

test("manual speech can bypass TTS while AI uses its own TTS profile", () => {
  const config = normalizeConfig({
    tts: { gptWeightsPath: "base.ckpt", sovitsWeightsPath: "base.pth" },
    ttsProfiles: {
      manual: { gptWeightsPath: "manual.ckpt", sovitsWeightsPath: "manual.pth" },
      ai: { gptWeightsPath: "ai.ckpt", sovitsWeightsPath: "ai.pth" },
    },
  });

  assert.equal(resolveTtsProfile(config, "manual").tts.gptWeightsPath, "manual.ckpt");
  assert.equal(resolveTtsProfile(config, "ai").tts.gptWeightsPath, "ai.ckpt");
  assert.equal(resolveTtsProfile(config, "ai-idle").tts.sovitsWeightsPath, "ai.pth");
  assert.equal(
    createLineJob("不生成语音", config, "manual-no-audio", {
      source: "manual",
      enableTts: false,
    }).publish.enableTts,
    false,
  );
});

test("CaptionStore replaces the previous line and increments event ids", () => {
  const store = new CaptionStore();
  const config = normalizeConfig({ captionDurationSeconds: 0 });

  const first = store.publish("第一句", config);
  const second = store.publish("第二句", config);

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(store.current().text, "第二句");
  assert.equal(store.current().visible, true);
});

test("CaptionStore attaches editable labels from the publication source", () => {
  const store = new CaptionStore();
  const config = normalizeConfig({
    speakerLabels: { manual: "管理", ai: "雪风" },
  });

  assert.equal(
    store.publish("人工台词", config, { source: "manual" }).speakerLabel,
    "管理",
  );
  assert.equal(
    store.publish("AI 台词", config, { source: "ai" }).speakerLabel,
    "雪风",
  );
});

test("caption events carry adjustable source-label mask geometry", () => {
  const config = normalizeConfig({
    captionSpeakerLabelBox: {
      offsetX: -12,
      offsetY: -52,
      minWidth: 156,
      fontSize: 25,
    },
  });
  const event = new CaptionStore().publish("人工台词", config, { source: "manual" });
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const captionJs = fs.readFileSync(
    path.join(root, "src", "public", "caption.js"),
    "utf8",
  );
  const captionCss = fs.readFileSync(
    path.join(root, "src", "public", "caption.css"),
    "utf8",
  );

  assert.deepEqual(event.speakerLabelBox, config.captionSpeakerLabelBox);
  assert.match(html, /captionSpeakerLabelBox\.offsetX/);
  assert.match(html, /captionSpeakerLabelBox\.offsetY/);
  assert.match(html, /captionSpeakerLabelBox\.minWidth/);
  assert.match(captionJs, /speakerLabelBox/);
  assert.match(captionCss, /caption-speaker-label:empty/);
});

test("music log store excludes ordinary server and TTS messages", () => {
  const store = new BiliMusicLogStore();

  store.record({ kind: "tts", message: "hidden" });
  store.record({ kind: "server", message: "hidden" });
  store.record({ kind: "music_queue", message: "visible" });

  assert.deepEqual(
    store.current().entries.map((entry) => entry.message),
    ["visible"],
  );
});

test("music log store replaces summary events with the BiliNCM backend log stream", () => {
  const store = new BiliMusicLogStore();
  store.record({ kind: "music_queue", message: "点歌队列为空。" });

  store.syncBackendLogs([
    { time: "16:19:34", color: "Green", message: "CDP 注入成功" },
    { time: "16:19:36", color: "Magenta", message: "收到点歌" },
  ]);

  assert.deepEqual(
    store.current().entries.map((entry) => ({
      time: entry.displayTime,
      color: entry.color,
      message: entry.message,
    })),
    [
      { time: "16:19:34", color: "Green", message: "CDP 注入成功" },
      { time: "16:19:36", color: "Magenta", message: "收到点歌" },
    ],
  );
});

test("CaptionAudioStore exposes one playable audio event per AI line", () => {
  const store = new CaptionAudioStore();

  const first = store.publish({
    jobId: "reply-1",
    text: "hello",
    audioUrl: "/audio/reply-1.wav",
    source: "ai",
  });
  const second = store.publish({
    jobId: "reply-2",
    text: "next",
    audioUrl: "/audio/reply-2.wav",
    source: "ai",
  });

  assert.equal(first.id, 1);
  assert.equal(first.shouldPlay, true);
  assert.equal(first.audioUrl, "/audio/reply-1.wav");
  assert.equal(second.id, 2);
  assert.equal(store.current().jobId, "reply-2");
  assert.equal(store.current().source, "ai");
});

test("CaptionAudioStore expires old playable audio to avoid replay on browser source reload", () => {
  let now = Date.parse("2026-06-18T00:00:00.000Z");
  const store = new CaptionAudioStore({ now: () => now });

  store.publish({
    jobId: "reply-1",
    text: "hello",
    audioUrl: "/audio/reply-1.wav",
    source: "ai",
    playWindowSeconds: 2,
  });

  assert.equal(store.current().shouldPlay, true);
  now += 2500;
  assert.equal(store.current().shouldPlay, false);
  assert.equal(store.current().audioUrl, "/audio/reply-1.wav");
});

test("DialogueLogStore keeps only the latest Snowkaze lines in order", () => {
  const store = new DialogueLogStore({ limit: 3 });

  store.record({ id: "1", text: "first" });
  store.record({ id: "2", text: "second" });
  store.record({ id: "3", text: "third" });
  store.record({ id: "4", text: "fourth" });

  assert.deepEqual(
    store.current().entries.map((entry) => [entry.id, entry.text]),
    [
      ["2", "second"],
      ["3", "third"],
      ["4", "fourth"],
    ],
  );
});

test("server publishes AI audio and recent Snowkaze lines to caption state", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");

  assert.match(server, /new CaptionAudioStore/);
  assert.match(server, /new DialogueLogStore/);
  assert.match(server, /captionAudio\.publish/);
  assert.match(server, /dialogueLog\.record/);
  assert.match(server, /audio:\s*captionAudio\.current\(\)/);
  assert.match(
    server,
    /dialogueLog:\s*dialogueLog\.current\(\{\s*limit:\s*config\.dialogueLog\.maxLines/,
  );
});

test("caption source keeps the original white box and renders a source label", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "caption.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "caption.js"),
    "utf8",
  );

  assert.match(html, /captionImage/);
  assert.match(html, /captionSpeakerLabel/);
  assert.match(js, /speakerLabelNode/);
  assert.doesNotMatch(js, /AudioRouter/);
  assert.doesNotMatch(js, /renderDialogueLog/);
});

test("overlay sources split caption, dialogue, and BiliNCM logs", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const caption = fs.readFileSync(
    path.join(root, "src", "public", "caption.html"),
    "utf8",
  );
  const dialogue = fs.readFileSync(
    path.join(root, "src", "public", "dialogue.html"),
    "utf8",
  );
  const logOverlay = fs.readFileSync(
    path.join(root, "src", "public", "log-overlay.html"),
    "utf8",
  );

  assert.doesNotMatch(caption, /snowkazeDialogueLog/);
  assert.match(dialogue, /snowkazeDialogueLog/);
  assert.match(logOverlay, /musicLog/);
  assert.match(server, /dialogueSourceUrl/);
  assert.match(server, /logOverlayUrl/);
  assert.match(server, /pathname === "\/dialogue"/);
  assert.match(server, /pathname === "\/log-overlay"/);
});

test("log overlay anchors its viewport to the newest rendered entry", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const logOverlayJs = fs.readFileSync(
    path.join(root, "src", "public", "log-overlay.js"),
    "utf8",
  );

  assert.match(logOverlayJs, /musicLogNode\.scrollTop\s*=\s*musicLogNode\.scrollHeight/);
});

test("caption source stays visual while the diagnostic audio player remains available", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const captionJs = fs.readFileSync(
    path.join(root, "src", "public", "caption.js"),
    "utf8",
  );
  const audioHtmlPath = path.join(root, "src", "public", "audio-player.html");
  const audioJsPath = path.join(root, "src", "public", "audio-player.js");

  assert.match(server, /captionSourceUrl/);
  assert.match(server, /audioPlayerUrl/);
  assert.match(server, /pathname === "\/audio-player"/);
  assert.doesNotMatch(captionJs, /AudioRouter/);
  assert.equal(fs.existsSync(audioHtmlPath), true);
  assert.equal(fs.existsSync(audioJsPath), true);

  const audioHtml = fs.readFileSync(audioHtmlPath, "utf8");
  const audioJs = fs.readFileSync(audioJsPath, "utf8");
  assert.match(audioHtml, /caption-audio-player/);
  assert.match(audioJs, /AudioRouter/);
  assert.match(audioJs, /AudioPlaybackController/);
  assert.match(audioJs, /controller\.start\(\)/);
});

test("caption and diagnostic audio player poll quickly for back-to-back TTS lines", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const captionJs = fs.readFileSync(
    path.join(root, "src", "public", "caption.js"),
    "utf8",
  );
  const audioJs = fs.readFileSync(
    path.join(root, "src", "public", "audio-player.js"),
    "utf8",
  );
  const controllerJs = fs.readFileSync(
    path.join(root, "src", "public", "audio-playback-controller.js"),
    "utf8",
  );

  assert.match(captionJs, /setInterval\(poll,\s*100\)/);
  assert.match(audioJs, /controller\.start\(\)/);
  assert.match(controllerJs, /intervalMilliseconds = 100/);
});

test("dialogue overlay settings control Snowkaze recent line layout", () => {
  const config = normalizeConfig({
    dialogueLog: {
      x: "120",
      y: "240",
      width: "520",
      height: "260",
      fontSize: "22",
      maxLines: "3",
      itemMinHeight: "70",
      gap: "14",
    },
  });
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "dialogue.js"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(root, "src", "public", "dialogue.css"),
    "utf8",
  );
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");

  assert.deepEqual(config.dialogueLog, {
    x: 120,
    y: 240,
    width: 520,
    height: 260,
    fontSize: 22,
    maxLines: 3,
    itemMinHeight: 70,
    gap: 14,
  });
  assert.match(html, /dialogueLog\.x/);
  assert.match(html, /dialogueLog\.height/);
  assert.match(html, /dialogueLog\.itemMinHeight/);
  assert.match(html, /dialogueLog\.gap/);
  assert.match(html, /dialogueLog\.maxLines/);
  assert.match(js, /applyLayout/);
  assert.match(js, /settings\.fontSize/);
  assert.match(js, /settings\.height/);
  assert.match(js, /settings\.itemMinHeight/);
  assert.match(js, /settings\.gap/);
  assert.doesNotMatch(css, /max-height:\s*76px/);
  assert.match(css, /\.dialogue-log\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.dialogue-log-entry[\s\S]*flex:\s*0 0 auto/);
  assert.match(
    server,
    /dialogueLog\.current\(\{\s*limit:\s*config\.dialogueLog\.maxLines/,
  );
});

test("AI status exposes current and recent AI TTS generation details", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
  const html = fs.readFileSync(
    path.join(root, "src", "public", "control.html"),
    "utf8",
  );
  const js = fs.readFileSync(
    path.join(root, "src", "public", "control.js"),
    "utf8",
  );

  assert.match(server, /const aiTtsStatus/);
  assert.match(server, /startAiTtsStatus\(job,\s*segment\)/);
  assert.match(server, /finishAiTtsStatus\(job,\s*audioPath\)/);
  assert.match(server, /failAiTtsStatus\(job,\s*error\)/);
  assert.match(server, /tts:\s*publicAiTtsStatus\(\)/);
  assert.match(html, /aiTtsStatusPanel/);
  assert.match(html, /aiTtsCurrentText/);
  assert.match(html, /aiTtsRecentList/);
  assert.match(js, /renderAiTtsStatus/);
  assert.match(js, /aiTtsCurrentText/);
  assert.match(js, /audioUrl/);
});

test("ConfigStore persists normalized settings outside the repository", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-bridge-"));
  const configPath = path.join(directory, "config.json");
  const store = new ConfigStore(configPath);

  store.save({ captionDurationSeconds: 7, captionAnimation: "instant" });
  const reloaded = new ConfigStore(configPath).load();

  assert.equal(reloaded.captionDurationSeconds, 7);
  assert.equal(reloaded.captionAnimation, "instant");
  assert.equal(reloaded.roomId, "");
});

test("ConfigStore preserves existing nested AI settings on partial save", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dialogue-bridge-"));
  const configPath = path.join(directory, "config.json");
  const store = new ConfigStore(configPath);

  store.save({
    ai: {
      enabled: true,
      model: "deepseek-reasoner",
      requestTimeoutSeconds: 45,
    },
  });
  store.save({ ai: { persona: "stay concise" } });

  const reloaded = new ConfigStore(configPath).load();
  assert.equal(reloaded.ai.enabled, true);
  assert.equal(reloaded.ai.model, "deepseek-reasoner");
  assert.equal(reloaded.ai.requestTimeoutSeconds, 45);
  assert.equal(reloaded.ai.persona, "stay concise");
});

test("ConfigStore preserves nested music settings on a partial save", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-music-config-"));
  const store = new ConfigStore(path.join(directory, "config.json"));

  store.save({
    music: {
      voiceMeeter: { enabled: true, inputStrip: "Strip[1]" },
    },
  });
  store.save({ music: { outputMode: "stream_only" } });

  const config = store.load();
  assert.deepEqual(config.music.voiceMeeter, {
    enabled: true,
    remoteDllPath: "",
    inputStrip: "Strip[1]",
  });
  assert.equal(config.music.outputMode, "stream_only");
});

test("SecretStore saves and redacts API keys", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-secrets-"));
  const store = new SecretStore(path.join(directory, "secrets.json"));

  assert.deepEqual(store.status(), {
    hasAiApiKey: false,
    hasTencentCloudCredentials: false,
  });

  store.setAiApiKey("  sk-test-secret  ");

  assert.equal(store.getAiApiKey(), "sk-test-secret");
  const status = store.status();
  assert.deepEqual(status, {
    hasAiApiKey: true,
    hasTencentCloudCredentials: false,
  });
  assert.doesNotMatch(JSON.stringify(status), /sk-test-secret/);
});

test("SecretStore clears empty API keys", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-secrets-"));
  const store = new SecretStore(path.join(directory, "secrets.json"));

  store.setAiApiKey("sk-test-secret");
  store.setAiApiKey("");

  assert.equal(store.getAiApiKey(), "");
  assert.deepEqual(store.status(), {
    hasAiApiKey: false,
    hasTencentCloudCredentials: false,
  });
});

test("SecretStore recovers from invalid JSON without exposing secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-secrets-"));
  const secretsPath = path.join(directory, "secrets.json");
  fs.writeFileSync(secretsPath, "{invalid", "utf8");
  const store = new SecretStore(secretsPath);

  assert.equal(store.getAiApiKey(), "");
  assert.deepEqual(store.status(), {
    hasAiApiKey: false,
    hasTencentCloudCredentials: false,
  });

  store.setAiApiKey("sk-recovered-secret");

  assert.deepEqual(JSON.parse(fs.readFileSync(secretsPath, "utf8")), {
    aiApiKey: "sk-recovered-secret",
  });
  assert.doesNotMatch(JSON.stringify(store.status()), /sk-recovered-secret/);
});

test("SecretStore creates parent folders and clears whitespace keys on disk", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-secrets-"));
  const secretsPath = path.join(directory, "nested", "secrets.json");
  const store = new SecretStore(secretsPath);

  store.setAiApiKey("sk-test-secret");
  assert.deepEqual(JSON.parse(fs.readFileSync(secretsPath, "utf8")), {
    aiApiKey: "sk-test-secret",
  });

  store.setAiApiKey("   ");

  assert.equal(store.getAiApiKey(), "");
  assert.deepEqual(store.status(), {
    hasAiApiKey: false,
    hasTencentCloudCredentials: false,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(secretsPath, "utf8")), {});
});

test("SecretStore saves and redacts Tencent Cloud search credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-secrets-"));
  const secretsPath = path.join(directory, "secrets.json");
  const store = new SecretStore(secretsPath);

  store.setTencentCloudCredentials({
    secretId: "  tc-secret-id  ",
    secretKey: "  tc-secret-key  ",
  });

  assert.deepEqual(store.getTencentCloudCredentials(), {
    secretId: "tc-secret-id",
    secretKey: "tc-secret-key",
  });
  assert.deepEqual(store.status(), {
    hasAiApiKey: false,
    hasTencentCloudCredentials: true,
  });
  assert.doesNotMatch(JSON.stringify(store.status()), /tc-secret-key/);

  store.setTencentCloudCredentials({ secretId: "", secretKey: "" });

  assert.deepEqual(store.getTencentCloudCredentials(), {
    secretId: "",
    secretKey: "",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(secretsPath, "utf8")), {});
});

test("AiMemoryStore persists danmaku and marks duplicates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const dbPath = path.join(directory, "memory.sqlite");
  const message = {
    id: "msg-1",
    roomId: "room-1",
    userId: "user-1",
    userName: "viewer-a",
    text: "hello bridge",
    receivedAt: "2026-06-16T01:02:03.000Z",
    source: "bilibili",
  };
  const store = new AiMemoryStore(dbPath);

  assert.equal(store.recordDanmaku(message).inserted, true);
  assert.equal(store.recordDanmaku(message).inserted, false);
  assert.equal(store.getUnclaimedMessages({ limit: 10 }).length, 1);

  store.close();
  const reloaded = new AiMemoryStore(dbPath);
  assert.equal(reloaded.getUnclaimedMessages({ limit: 10 }).length, 1);
  reloaded.close();
});

test("AiMemoryStore stores reply tasks and marks interrupted tasks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  store.createReplyTask({
    id: "task1",
    source: "ai",
    targetUserId: "u1",
    targetUserName: "viewer-a",
    sourceMessageIds: ["m1", "m2"],
    originalReply: "line one\nline two",
    status: "queued",
  });
  store.createReplySegments("task1", ["line one", "line two"]);

  assert.equal(store.getQueuedSegments().length, 2);
  assert.deepEqual(store.getReplyTask("task1"), {
    id: "task1",
    source: "ai",
    targetUserId: "u1",
    targetUserName: "viewer-a",
    sourceMessageIds: ["m1", "m2"],
    originalReply: "line one\nline two",
    status: "queued",
  });

  store.markStartupInterrupted();

  assert.equal(store.getQueuedSegments().length, 0);
  assert.equal(store.getReplyTask("task1").status, "interrupted");
  store.close();
});

test("AiMemoryStore defaults reply tasks to queued", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  store.createReplyTask({
    id: "default-status-task",
    source: "ai",
    sourceMessageIds: [],
    originalReply: "queued by default",
  });

  assert.equal(store.getReplyTask("default-status-task").status, "queued");
  store.close();
});

test("AiMemoryStore can mark messages claimed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));
  store.recordDanmaku({
    id: "msg-claimed",
    roomId: "room-1",
    userId: "user-1",
    userName: "viewer-a",
    text: "claim me",
    receivedAt: "2026-06-16T01:02:03.000Z",
    source: "bilibili",
  });

  store.markMessagesStatus(["msg-claimed"], "claimed");

  assert.equal(store.getUnclaimedMessages({ limit: 10 }).length, 0);
  store.close();
});

test("AiMemoryStore returns the latest conversation events in chronological order", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  for (let index = 1; index <= 105; index += 1) {
    store.recordConversationEvent({
      id: `event-${index}`,
      kind: "danmaku",
      userId: `u${index % 3}`,
      userName: `viewer-${index % 3}`,
      text: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 5, 16, 0, index)).toISOString(),
    });
  }

  const events = store.getRecentConversationEvents({ limit: 100 });

  assert.equal(events.length, 100);
  assert.equal(events[0].id, "event-6");
  assert.equal(events.at(-1).id, "event-105");
  assert.equal(events[0].text, "message 6");
  assert.equal(events.at(-1).text, "message 105");
  store.close();
});

test("AiMemoryStore trims local conversation events to the requested limit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  for (let index = 1; index <= 5; index += 1) {
    store.recordConversationEvent({
      id: `trim-${index}`,
      kind: "danmaku",
      text: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 5, 16, 0, index)).toISOString(),
    });
  }

  const result = store.trimConversationEvents(3);
  const events = store.getRecentConversationEvents({ limit: 10 });

  assert.equal(result.deleted, 2);
  assert.deepEqual(
    events.map((event) => event.id),
    ["trim-3", "trim-4", "trim-5"],
  );
  store.close();
});

test("AiMemoryStore records MCP search results as short-term memory metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  store.recordSearchResult({
    id: "search-1",
    query: "重庆天气",
    provider: "tencent-wsa-mcp",
    createdAt: "2026-06-18T10:00:00.000Z",
    results: [
      {
        title: "重庆天气预报",
        url: "https://example.test/weather/chongqing",
        snippet: "重庆今天多云，气温 26 到 33 度。",
        source: "example-weather",
      },
    ],
  });

  const events = store.getRecentConversationEvents({ limit: 10 });
  const longTerm = store.listLongTermMemories({ status: "active" });

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_search");
  assert.equal(events[0].text.includes("重庆天气"), true);
  assert.equal(events[0].metadata.query, "重庆天气");
  assert.equal(events[0].metadata.provider, "tencent-wsa-mcp");
  assert.equal(events[0].metadata.results[0].title, "重庆天气预报");
  assert.equal(longTerm.length, 0);
  store.close();
});

test("memory summarizer promotes repeated candidates and explicit long-term requests", async () => {
  const { applyMemorySummaryResult } = await import(
    "../src/ai-memory-manager.mjs"
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));
  const repeatedCandidate = {
    type: "topic_memory",
    content: "直播间最近经常聊重庆旅游，观众对重庆话题感兴趣。",
    sourceEventIds: ["event-1"],
    importance: 3,
    confidence: 0.8,
    reason: "同类话题反复出现。",
    rememberLongTerm: false,
  };

  applyMemorySummaryResult(store, {
    shortTermSummary: "大家在聊重庆。",
    memoryCandidates: [repeatedCandidate],
    styleAdjustments: [],
  });
  applyMemorySummaryResult(store, {
    shortTermSummary: "又聊到重庆旅行。",
    memoryCandidates: [repeatedCandidate],
    styleAdjustments: [],
  });
  applyMemorySummaryResult(store, {
    shortTermSummary: "重庆旅行话题第三次出现。",
    memoryCandidates: [repeatedCandidate],
    styleAdjustments: [],
  });
  applyMemorySummaryResult(store, {
    shortTermSummary: "雪风查到了直播互动规则。",
    memoryCandidates: [
      {
        type: "fact_memory",
        content: "B站直播互动规则资料值得后续直播参考。",
        sourceEventIds: ["search-1"],
        importance: 4,
        confidence: 0.9,
        reason: "雪风明确判断以后还会用到。",
        rememberLongTerm: true,
      },
    ],
    styleAdjustments: ["最近观众喜欢短句回答。"],
  });

  const active = store.listLongTermMemories({ status: "active" });
  assert.deepEqual(
    active.map((memory) => [memory.type, memory.content, memory.hitCount]),
    [
      [
        "topic_memory",
        "直播间最近经常聊重庆旅游，观众对重庆话题感兴趣。",
        3,
      ],
      ["fact_memory", "B站直播互动规则资料值得后续直播参考。", 1],
      ["style_memory", "最近观众喜欢短句回答。", 1],
    ],
  );
  assert.equal(store.getStreamSummary(), "雪风查到了直播互动规则。");
  store.close();
});

test("time-sensitive weather search candidates stay out of visible long-term memory", async () => {
  const { applyMemorySummaryResult } = await import(
    "../src/ai-memory-manager.mjs"
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  applyMemorySummaryResult(store, {
    shortTermSummary: "刚刚查询了重庆今天的天气。",
    memoryCandidates: [
      {
        type: "fact_memory",
        content: "重庆今天多云，气温 26 到 33 度。",
        sourceEventIds: ["search-weather"],
        importance: 2,
        confidence: 0.7,
        reason: "天气信息很快过期，只保留短期情景。",
        rememberLongTerm: false,
      },
    ],
    styleAdjustments: [],
  });

  assert.equal(store.listLongTermMemories({ status: "active" }).length, 0);
  assert.equal(store.listLongTermMemories({ status: "needs_review" }).length, 1);
  assert.equal(store.listVisibleLongTermMemories().length, 0);
  store.close();
});

test("AiMemoryStore searches active long-term memories by live topic while keeping style rules", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  store.upsertLongTermMemory({
    type: "topic_memory",
    content: "直播间最近经常聊重庆旅游，观众对重庆话题感兴趣。",
    source: "test",
    importance: 4,
    confidence: 0.9,
    status: "active",
  });
  store.upsertLongTermMemory({
    type: "topic_memory",
    content: "直播间也讨论过纳西妲配队。",
    source: "test",
    importance: 5,
    confidence: 0.9,
    status: "active",
  });
  store.upsertLongTermMemory({
    type: "style_memory",
    content: "雪风回复要短一点，像正在直播聊天。",
    source: "test",
    importance: 3,
    confidence: 0.8,
    status: "active",
  });
  store.upsertLongTermMemory({
    type: "fact_memory",
    content: "重庆今天多云，气温 26 到 33 度。",
    source: "weather",
    importance: 4,
    confidence: 0.8,
    status: "needs_review",
  });

  const memories = store.searchRelevantLongTermMemories({
    query: "观众问重庆天气，直播间正在聊重庆旅行。",
    limit: 5,
  });

  assert.deepEqual(
    memories.map((memory) => memory.type),
    ["style_memory", "topic_memory"],
  );
  assert.equal(memories[1].content.includes("重庆旅游"), true);
  assert.equal(memories.some((memory) => memory.content.includes("纳西妲")), false);
  assert.equal(memories.some((memory) => memory.status === "needs_review"), false);
  store.close();
});

test("AiMemoryStore records actionable live event kinds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  store.recordActionableEvent({
    id: "enter-1",
    roomId: "123456",
    kind: "room_enter",
    userId: "u1",
    userName: "viewer-a",
    text: "viewer-a 进入了直播间",
    receivedAt: "2026-06-16T02:00:00.000Z",
    source: "bilibili",
  });

  const messages = store.getUnclaimedMessages({ limit: 10 });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "enter-1");
  assert.equal(messages[0].kind, "room_enter");
  assert.equal(messages[0].text, "viewer-a 进入了直播间");
  store.close();
});

test("ReplyQueue executes one segment at a time in order", async () => {
  const calls = [];
  const queue = new ReplyQueue({
    executeSegment: async (segment) => {
      calls.push(segment.text);
    },
    wait: async () => {},
  });

  queue.enqueueTask({
    id: "task1",
    segments: [
      { id: "s1", text: "line one" },
      { id: "s2", text: "line two" },
    ],
    segmentDelaySeconds: 0,
  });
  await queue.drain();

  assert.deepEqual(calls, ["line one", "line two"]);
  assert.equal(queue.status().busy, false);
});

test("ReplyQueue pauses after current segment and preserves remaining segments", async () => {
  const calls = [];
  const queue = new ReplyQueue({
    executeSegment: async (segment) => {
      calls.push(segment.text);
      queue.pause();
    },
    wait: async () => {},
  });

  queue.enqueueTask({
    id: "task1",
    segments: [
      { id: "s1", text: "line one" },
      { id: "s2", text: "line two" },
    ],
    segmentDelaySeconds: 0,
  });
  await queue.drain();

  assert.deepEqual(calls, ["line one"]);
  assert.equal(queue.status().paused, true);
  assert.equal(queue.status().queuedSegments, 1);
});

test("ReplyQueue removes queued idle segments without interrupting current audio", async () => {
  const calls = [];
  let releaseCurrent;
  const queue = new ReplyQueue({
    executeSegment: async (segment) => {
      calls.push(segment.id);
      if (segment.id === "idle-current") {
        await new Promise((resolve) => {
          releaseCurrent = resolve;
        });
      }
    },
    wait: async () => {},
  });

  queue.enqueueTask({
    id: "idle",
    priority: "idle",
    segments: [{ id: "idle-current" }, { id: "idle-next" }],
  });
  const draining = queue.drain();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    queue.cancelQueued((segment) => segment.priority === "idle"),
    1,
  );
  queue.enqueueTask({
    id: "viewer",
    priority: "normal",
    segments: [{ id: "viewer-1" }],
  });
  releaseCurrent();
  await draining;

  assert.deepEqual(calls, ["idle-current", "viewer-1"]);
});

test("ReplyQueue inserts normal segments before queued idle segments", () => {
  const queue = new ReplyQueue({ executeSegment: async () => {}, wait: async () => {} });

  queue.enqueueTask({
    id: "idle",
    priority: "idle",
    segments: [{ id: "idle-1" }],
  });
  queue.enqueueTask({
    id: "viewer",
    priority: "normal",
    segments: [{ id: "viewer-1" }],
  });

  assert.deepEqual(
    queue.status().queued.map((segment) => segment.id),
    ["viewer-1", "idle-1"],
  );
});

test("normalizeBiliDanmaku converts DANMU_MSG into bridge message", () => {
  const message = normalizeBiliDanmaku(
    {
      cmd: "DANMU_MSG",
      info: [[0, 1, 25], "hello danmaku", [123, "viewer-a"]],
    },
    { roomId: "123456" },
  );

  assert.equal(message.roomId, "123456");
  assert.equal(message.userId, "123");
  assert.equal(message.userName, "viewer-a");
  assert.equal(message.text, "hello danmaku");
  assert.equal(message.source, "bilibili");
  assert.equal(message.status, "unclaimed");
  assert.equal(typeof message.id, "string");
  assert.ok(message.receivedAt);
});

test("normalizeBiliLiveEvent converts room entry events into actionable live events", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "INTERACT_WORD",
      data: {
        uid: 456,
        uname: "viewer-b",
        msg_type: 1,
        timestamp: 1780000000,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.roomId, "123456");
  assert.equal(event.kind, "room_enter");
  assert.equal(event.actionable, true);
  assert.equal(event.userId, "456");
  assert.equal(event.userName, "viewer-b");
  assert.equal(event.text, "viewer-b 进入了直播间");
  assert.equal(event.source, "bilibili");
  assert.equal(event.status, "unclaimed");
  assert.equal(typeof event.id, "string");
});

test("normalizeBiliLiveEvent converts follow events into actionable live events", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "INTERACT_WORD",
      data: {
        uid: 654,
        uname: "viewer-follow",
        msg_type: 2,
        timestamp: 1780000002,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "follow");
  assert.equal(event.actionable, true);
  assert.equal(event.userId, "654");
  assert.equal(event.userName, "viewer-follow");
  assert.equal(event.text, "viewer-follow 关注了直播间");
});

test("normalizeBiliLiveEvent converts V2 room entry and follow events into chat context", () => {
  const enter = normalizeBiliLiveEvent(
    {
      cmd: "INTERACT_WORD_V2",
      data: {
        uid: 987,
        uname: "viewer-v2",
        msg_type: 1,
        timestamp: 1780000100,
      },
    },
    { roomId: "123456" },
  );
  const follow = normalizeBiliLiveEvent(
    {
      cmd: "INTERACT_WORD_V2",
      data: {
        uid: 988,
        uname: "viewer-follow-v2",
        msg_type: 2,
        timestamp: 1780000101,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(enter.kind, "room_enter");
  assert.equal(enter.userName, "viewer-v2");
  assert.equal(enter.actionable, true);
  assert.equal(follow.kind, "follow");
  assert.equal(follow.userName, "viewer-follow-v2");
  assert.equal(follow.actionable, true);
});

test("normalizeBiliLiveEvent decodes V2 protobuf room entry events", () => {
  function encodeVarint(value) {
    const bytes = [];
    let remaining = Number(value);
    while (remaining >= 0x80) {
      bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(remaining);
    return bytes;
  }
  function encodeField(field, wireType) {
    return encodeVarint((field << 3) | wireType);
  }
  function encodeStringField(field, value) {
    const text = Buffer.from(value, "utf8");
    return [
      ...encodeField(field, 2),
      ...encodeVarint(text.length),
      ...text,
    ];
  }
  function encodeVarintField(field, value) {
    return [...encodeField(field, 0), ...encodeVarint(value)];
  }
  const pb = Buffer.from([
    ...encodeVarintField(1, 12001),
    ...encodeStringField(2, "pb-viewer"),
    ...encodeVarintField(5, 1),
    ...encodeVarintField(7, 1780000200),
    ...encodeVarintField(16, 0),
  ]).toString("base64");

  const event = normalizeBiliLiveEvent(
    {
      cmd: "INTERACT_WORD_V2",
      data: {
        dmscore: 1,
        pb,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "room_enter");
  assert.equal(event.userId, "12001");
  assert.equal(event.userName, "pb-viewer");
  assert.equal(event.text, "pb-viewer 进入了直播间");
  assert.equal(event.actionable, true);
  assert.equal(event.receivedAt, "2026-05-28T20:30:00.000Z");
});

test("normalizeBiliLiveEvent converts entry effects into room entry context", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "ENTRY_EFFECT",
      data: {
        uid: 4567,
        uinfo: {
          base: {
            name: "舰长观众",
          },
        },
        trigger_time: 1780000102,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "room_enter");
  assert.equal(event.userId, "4567");
  assert.equal(event.userName, "舰长观众");
  assert.equal(event.text, "舰长观众 进入了直播间");
  assert.equal(event.actionable, true);
});

test("normalizeBiliLiveEvent tolerates out-of-range entry effect timestamps", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "ENTRY_EFFECT",
      data: {
        uid: 4568,
        uinfo: {
          base: {
            name: "timestamp-viewer",
          },
        },
        trigger_time: 9999999999999999999,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "room_enter");
  assert.equal(event.userName, "timestamp-viewer");
  assert.doesNotThrow(() => new Date(event.receivedAt).toISOString());
});

test("normalizeBiliLiveEvent converts gift events into actionable live events", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "SEND_GIFT",
      data: {
        tid: "gift-tid-1",
        uid: 789,
        uname: "viewer-c",
        giftName: "flower",
        num: 3,
        timestamp: 1780000001,
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "gift");
  assert.equal(event.actionable, true);
  assert.equal(event.userId, "789");
  assert.equal(event.userName, "viewer-c");
  assert.equal(event.text, "viewer-c 送出了 flower x3");
});

test("normalizeBiliLiveEvent converts online rank updates into passive context", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "ONLINE_RANK_V2",
      data: {
        list: [
          { uid: 1, uname: "viewer-a" },
          { uid: 2, uname: "viewer-b" },
        ],
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "online_snapshot");
  assert.equal(event.actionable, false);
  assert.equal(event.text, "在线榜参考：viewer-a、viewer-b");
});

test("normalizeBiliLiveEvent converts V3 online rank updates into passive context", () => {
  const event = normalizeBiliLiveEvent(
    {
      cmd: "ONLINE_RANK_V3",
      data: {
        list: [
          { uid: 1, uname: "viewer-a" },
          { uid: 2, uname: "viewer-b" },
        ],
      },
    },
    { roomId: "123456" },
  );

  assert.equal(event.kind, "online_snapshot");
  assert.equal(event.actionable, false);
  assert.equal(event.text, "在线榜参考：viewer-a、viewer-b");
});

test("extractPageChatItemsFromDocument reads new Bilibili chat-item rows", () => {
  const message = { textContent: "你觉得印蓄亚第一件装备出什么好" };
  const name = { textContent: "吖叶飘凛" };
  const row = {
    textContent: "粉1 23 吖叶飘凛 · 你觉得印蓄亚第一件装备出什么好",
    innerText: "粉1 23 吖叶飘凛 · 你觉得印蓄亚第一件装备出什么好",
    querySelector(selector) {
      if (String(selector).includes("nickname")) return name;
      if (String(selector).includes("message-content")) return message;
      return null;
    },
  };
  const documentStub = {
    querySelectorAll(selector) {
      return selector === "#chat-items .chat-item" ? [row] : [];
    },
  };

  const items = extractPageChatItemsFromDocument(documentStub);

  assert.deepEqual(items, [
    {
      index: 0,
      userName: "吖叶飘凛",
      text: "你觉得印蓄亚第一件装备出什么好",
    },
  ]);
});

test("extractPageChatItemsFromDocument falls back to row text when message spans changed", () => {
  const row = {
    textContent: "吖叶飘凛 · 你觉得印蓄亚第一件装备出什么好",
    innerText: "吖叶飘凛 · 你觉得印蓄亚第一件装备出什么好",
    querySelector() {
      return null;
    },
  };
  const documentStub = {
    querySelectorAll(selector) {
      return selector === "#chat-items [class*='chat-item']" ? [row] : [];
    },
  };

  const items = extractPageChatItemsFromDocument(documentStub);

  assert.deepEqual(items, [
    {
      index: 0,
      userName: "吖叶飘凛",
      text: "你觉得印蓄亚第一件装备出什么好",
    },
  ]);
});

test("extractPageChatItemsFromDocument ignores nested chat nodes from one Bilibili row", () => {
  const row = {
    textContent: "灬叶飘凛灬 : 你觉得贝蕾亚第一件装备出什么好",
    innerText: "灬叶飘凛灬 : 你觉得贝蕾亚第一件装备出什么好",
    parentElement: null,
    querySelector(selector) {
      if (String(selector).includes("nickname")) {
        return { textContent: "灬叶飘凛灬" };
      }
      if (String(selector).includes("message-content")) {
        return { textContent: "你觉得贝蕾亚第一件装备出什么好" };
      }
      return null;
    },
  };
  const nameNode = {
    textContent: "灬叶飘凛灬 :",
    innerText: "灬叶飘凛灬 :",
    parentElement: row,
    querySelector() {
      return null;
    },
  };
  const textNode = {
    textContent: "你觉得贝蕾亚第一件装备出什么好",
    innerText: "你觉得贝蕾亚第一件装备出什么好",
    parentElement: row,
    querySelector() {
      return null;
    },
  };
  const documentStub = {
    querySelectorAll(selector) {
      return selector === "#chat-items [class*='chat-item']"
        ? [row, nameNode, textNode]
        : [];
    },
  };

  const items = extractPageChatItemsFromDocument(documentStub);

  assert.deepEqual(items, [
    {
      index: 0,
      userName: "灬叶飘凛灬",
      text: "你觉得贝蕾亚第一件装备出什么好",
    },
  ]);
});

test("BiliReceiver dispatches new browser chat rows after seeding visible history", async () => {
  const snapshots = [
    [{ index: 0, userName: "雪风智乃", text: "old visible message" }],
    [
      { index: 0, userName: "雪风智乃", text: "old visible message" },
      { index: 1, userName: "雪风智乃", text: "new browser message" },
    ],
  ];
  const receiver = new BiliReceiver({
    pageProvider: async () => ({
      async evaluate() {
        return snapshots.shift() || snapshots.at(-1) || [];
      },
    }),
  });
  const events = [];
  receiver.addEventListener("live-event", (event) => {
    events.push(event.detail);
  });

  await receiver.startPageMirror({ roomId: "123456" });
  await receiver.pollPageChat();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "danmaku");
  assert.equal(events[0].userName, "雪风智乃");
  assert.equal(events[0].text, "new browser message");
  receiver.stop();
});

test("BiliReceiver treats the first non-empty browser chat poll as history when startup loads slowly", async () => {
  const snapshots = [
    [],
    [{ index: 0, userName: "雪风智乃", text: "history after slow load" }],
    [
      { index: 0, userName: "雪风智乃", text: "history after slow load" },
      { index: 1, userName: "雪风智乃", text: "new after baseline" },
    ],
  ];
  const receiver = new BiliReceiver({
    pageProvider: async () => ({
      async evaluate() {
        return snapshots.shift() || snapshots.at(-1) || [];
      },
    }),
  });
  const events = [];
  receiver.addEventListener("live-event", (event) => {
    events.push(event.detail);
  });

  await receiver.startPageMirror({ roomId: "123456" });
  await receiver.pollPageChat();
  await receiver.pollPageChat();

  assert.equal(events.length, 1);
  assert.equal(events[0].text, "new after baseline");
  receiver.stop();
});

test("BiliReceiver ignores browser mirror rows already seen from websocket by same viewer and text", async () => {
  const snapshots = [
    [{ index: 0, userName: "viewer-a", text: "history" }],
    [
      { index: 0, userName: "viewer-a", text: "history" },
      { index: 1, userName: "viewer-b", text: "same text" },
      { index: 2, userName: "viewer-a", text: "same text" },
    ],
  ];
  const receiver = new BiliReceiver({
    pageProvider: async () => ({
      async evaluate() {
        return snapshots.shift() || snapshots.at(-1) || [];
      },
    }),
  });
  const events = [];
  receiver.addEventListener("live-event", (event) => {
    events.push(event.detail);
  });

  await receiver.startPageMirror({ roomId: "123456" });
  receiver.ignorePageDanmaku({ userName: "viewer-a", text: "same text" });
  await receiver.pollPageChat();

  assert.equal(events.length, 1);
  assert.equal(events[0].userName, "viewer-b");
  assert.equal(events[0].text, "same text");
  receiver.stop();
});

test("BiliReceiver records recent command diagnostics from websocket packets", async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send() {}
    close() {}
  }
  const receiver = new BiliReceiver({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url) => ({
      async json() {
        if (String(url).includes("/room/v1/Room/room_init")) {
          return { code: 0, data: { room_id: 123456 } };
        }
        return {
          code: 0,
          data: {
            token: "token",
            host_list: [{ host: "example.chat.bilibili.com" }],
          },
        };
      },
    }),
  });

  await receiver.start({ roomId: "123456" });
  sockets[0].onmessage({
    data: buildBiliPacket({
      operation: 5,
      body: JSON.stringify({
        cmd: "INTERACT_WORD_V2",
        data: { uid: 12, uname: "viewer-enter", msg_type: 1 },
      }),
    }),
  });
  sockets[0].onmessage({
    data: buildBiliPacket({
      operation: 5,
      body: JSON.stringify({
        cmd: "STOP_LIVE_ROOM_LIST",
        data: { list: [], reason: "stopped" },
      }),
    }),
  });

  const status = receiver.currentStatus();

  assert.deepEqual(
    status.recentCommands.map((item) => [
      item.cmd,
      item.recognized,
      item.kind,
      item.actionable,
    ]),
    [
      ["STOP_LIVE_ROOM_LIST", false, "", false],
      ["INTERACT_WORD_V2", true, "room_enter", true],
    ],
  );
  assert.deepEqual(status.recentCommands[0].dataKeys, ["list", "reason"]);
  assert.equal(status.recentCommands[1].text.includes("viewer-enter"), true);
  assert.equal(status.commandCounts.STOP_LIVE_ROOM_LIST, 1);
  assert.equal(status.eventCounts.room_enter, 1);
  receiver.stop();
});

test("decodeBiliPackets decodes plain JSON operation packets", () => {
  const payload = JSON.stringify({
    cmd: "DANMU_MSG",
    info: [[], "hello", [1, "viewer-a"]],
  });
  const packet = buildBiliPacket({
    operation: 5,
    protocolVersion: 0,
    body: Buffer.from(payload),
  });

  const decoded = decodeBiliPackets(packet);

  assert.equal(decoded[0].operation, 5);
  assert.equal(decoded[0].protocolVersion, 0);
  assert.equal(decoded[0].body.cmd, "DANMU_MSG");
});

test("BiliReceiver falls back to legacy danmaku config when xlive info is blocked", async () => {
  const requestedUrls = [];
  const receiver = new BiliReceiver({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes("/room/v1/Room/room_init")) {
        return {
          async json() {
            return { code: 0, data: { room_id: 123456 } };
          },
        };
      }
      if (String(url).includes("/xlive/web-room/v1/index/getDanmuInfo")) {
        return {
          async json() {
            return { code: -352, message: "-352" };
          },
        };
      }
      if (String(url).includes("/room/v1/Danmu/getConf")) {
        return {
          async json() {
            return {
              code: 0,
              data: {
                host_server_list: [
                  {
                    host: "legacy-comet.chat.bilibili.com",
                    wss_port: 443,
                  },
                ],
                token: "legacy-token",
              },
            };
          },
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const server = await receiver.resolveDanmakuServer("123456");

  assert.equal(server.realRoomId, "123456");
  assert.equal(server.host, "legacy-comet.chat.bilibili.com");
  assert.equal(server.token, "legacy-token");
  assert.ok(
    requestedUrls.some((url) => url.includes("/room/v1/Danmu/getConf")),
  );
});

test("parseDirectorDecision accepts reply and clamps wait time", () => {
  assert.deepEqual(
    parseDirectorDecision(
      JSON.stringify({
        action: "reply",
        messageIds: ["m1", "m2"],
        targetUserId: "u1",
        waitSeconds: 9999,
        reason: "worth replying",
      }),
      { maxWaitSeconds: 120 },
    ),
    {
      action: "reply",
      messageIds: ["m1", "m2"],
      audience: "viewer",
      targetUserId: "u1",
      waitSeconds: 120,
      reason: "worth replying",
    },
  );
});

test("parseDirectorDecision falls back to wait for invalid decisions", () => {
  assert.deepEqual(
    parseDirectorDecision("{bad json", { maxWaitSeconds: 120 }),
    {
      action: "wait",
      messageIds: [],
      audience: "viewer",
      targetUserId: "",
      waitSeconds: 10,
      reason: "Director response could not be parsed; retry later.",
    },
  );
});

test("parseDirectorDecision preserves a room-wide reply without a target", () => {
  const result = parseDirectorDecision(
    JSON.stringify({
      action: "reply",
      messageIds: ["m1"],
      audience: "room",
      targetUserId: "",
      waitSeconds: 0,
      reason: "topic suits the whole room",
    }),
  );

  assert.equal(result.audience, "room");
  assert.equal(result.targetUserId, "");
});

test("parseDirectorDecision normalizes an unknown audience to viewer", () => {
  assert.equal(
    parseDirectorDecision('{"action":"reply","audience":"private"}').audience,
    "viewer",
  );
});

test("buildReplyMessages includes audience without requiring a viewer name", () => {
  const messages = buildReplyMessages({
    persona: "Snowkaze",
    interactionIntent: {
      audience: "viewer",
      targetUserName: "Xiaoming",
      source: "event",
    },
  });

  assert.match(messages[1].content, /"audience": "viewer"/);
  assert.match(messages[0].content, /Do not force a viewer name/);
});

test("parseProactiveDecision defaults to wait when JSON is invalid", async () => {
  const module = await import("../src/ai-director.mjs");
  assert.equal(typeof module.parseProactiveDecision, "function");
  assert.deepEqual(module.parseProactiveDecision("invalid"), {
    action: "wait",
    audience: "room",
    reason: "invalid proactive decision",
    wantsScreen: false,
  });
});

test("buildDirectorMessages includes current output state", () => {
  const messages = buildDirectorMessages({
    recentMessages: [
      { id: "m1", kind: "room_enter", userName: "viewer-a", text: "entered" },
    ],
    recentEvents: [
      { id: "online-1", kind: "online_snapshot", text: "在线榜参考：viewer-a" },
    ],
    outputState: { busy: true, current: { text: "answering" }, queuedSegments: 2 },
    memorySummary: "testing TTS today",
  });
  const text = JSON.stringify(messages);

  assert.match(text, /answering/);
  assert.match(text, /queuedSegments/);
  assert.match(text, /room_enter/);
  assert.match(text, /online_snapshot/);
  assert.match(text, /testing TTS today/);
});

test("AiOrchestrator emits one room proactive task after the idle threshold", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-idle-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    let currentTime = 0;
    const scene = new LiveSceneState({
      now: () => currentTime,
      random: () => 0,
    });
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => executed.push(segment),
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const aiClient = {
      complete: async (request) =>
        request.json
          ? JSON.stringify({
              action: "speak",
              audience: "room",
              reason: "there is a natural topic",
              wantsScreen: false,
            })
          : "The stream is quiet, so Snowkaze says hello.",
    };
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            model: "test-model",
            scene: {
              idleMinSeconds: 120,
              idleCooldownMinSeconds: 120,
              idleCooldownMaxSeconds: 120,
            },
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
      scene,
      now: () => new Date(currentTime),
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });

    scene.noteInteraction({ kind: "danmaku" });
    currentTime = 120_000;
    await orchestrator.tick();
    await orchestrator.tick();

    assert.equal(executed.every((segment) => segment.source === "ai-idle"), true);
    assert.equal(new Set(executed.map((segment) => segment.taskId)).size, 1);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator cancels queued idle speech before normal viewer output", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-idle-cancel-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => executed.push(segment.source),
      wait: async () => {},
    });
    queue.enqueueTask({
      id: "idle-task",
      priority: "idle",
      segments: [{ id: "idle-segment", text: "old idle line", source: "ai-idle" }],
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: { enabled: true, directorEnabled: false, model: "test-model" },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient: { complete: async () => "viewer reply" },
      queue,
      receiver,
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });

    await orchestrator.onDanmaku({
      id: "viewer-message",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "hello",
      source: "bilibili",
      receivedAt: "2026-06-20T00:00:00.000Z",
    });

    assert.deepEqual(executed, ["ai"]);
    assert.equal(queue.status().queued.some((segment) => segment.source === "ai-idle"), false);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator passes room intent to reply generation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-room-intent-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: { enabled: true, directorEnabled: true, model: "test-model" },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient: {
        complete: async (request) => {
          completeCalls.push(request);
          return completeCalls.length === 1
            ? JSON.stringify({
                action: "reply",
                messageIds: ["room-message"],
                audience: "room",
                targetUserId: "",
                waitSeconds: 0,
                reason: "share with room",
              })
            : "Let us all keep chatting.";
        },
      },
      queue: new ReplyQueue({ executeSegment: async () => {}, wait: async () => {} }),
      receiver,
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });

    await orchestrator.onDanmaku({
      id: "room-message",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "what should everyone play",
      source: "bilibili",
      receivedAt: "2026-06-20T00:00:00.000Z",
    });

    const replyPrompt = JSON.parse(completeCalls[1].messages[1].content);
    assert.equal(replyPrompt.interactionIntent.audience, "room");
    assert.equal(replyPrompt.interactionIntent.targetUserName, "");
  } finally {
    memory.close();
  }
});

test("AiOrchestrator does not call image input when vision is unverified", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-vision-gate-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    let currentTime = 0;
    const scene = new LiveSceneState({ now: () => currentTime, random: () => 0 });
    const requests = [];
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            model: "test-model",
            scene: {
              vision: { enabled: true, displayId: "DISPLAY1" },
            },
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient: {
        complete: async (request) => {
          requests.push(request);
          return request.json
            ? JSON.stringify({
                action: "speak",
                audience: "room",
                reason: "might need the screen",
                wantsScreen: true,
              })
            : "Snowkaze will keep the room company.";
        },
      },
      queue: new ReplyQueue({ executeSegment: async () => {}, wait: async () => {} }),
      receiver,
      scene,
      now: () => new Date(currentTime),
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });

    scene.noteInteraction({ kind: "danmaku" });
    currentTime = 120_000;
    await orchestrator.tick();

    assert.equal(requests.some((request) => "image" in request || "images" in request), false);
    assert.equal(scene.status().lastError, "当前模型的图像输入尚未验证。");
  } finally {
    memory.close();
  }
});

test("AiOrchestrator replies to every message when director is disabled", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-e2e-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const secrets = { getAiApiKey: () => "sk-test" };
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return "first segment\nsecond segment";
      },
    };
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => {
        executed.push(segment.text);
      },
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });

    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-reasoner",
            persona: "reply naturally",
          },
        }),
      memory,
      secrets,
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onDanmaku({
      id: "m1",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "hello",
      receivedAt: new Date().toISOString(),
      source: "bilibili",
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 1);
    assert.deepEqual(executed, ["first segment", "second segment"]);
    assert.equal(queue.status().queuedSegments, 0);
    assert.equal(memory.getUnclaimedMessages({ limit: 10 }).length, 0);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator provides a 100-event live context window to replies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-context-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    memory.setStreamSummary("Snowkaze is chatting while testing live context.");
    for (let index = 1; index <= 105; index += 1) {
      memory.recordConversationEvent({
        id: `context-${index}`,
        kind: "danmaku",
        userId: `u${index % 5}`,
        userName: `viewer-${index % 5}`,
        text: `prior message ${index}`,
        createdAt: new Date(Date.UTC(2026, 5, 16, 0, index)).toISOString(),
      });
    }

    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return "context reply";
      },
    };
    const queue = new ReplyQueue({
      executeSegment: async () => {},
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "remember recent live context naturally",
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onDanmaku({
      id: "current-message",
      roomId: "123456",
      userId: "new-viewer",
      userName: "new viewer",
      text: "hello snowkaze",
      receivedAt: "2026-06-16T02:00:00.000Z",
      source: "bilibili",
      status: "unclaimed",
    });

    const prompt = JSON.parse(completeCalls[0].messages[1].content);
    assert.equal(prompt.streamSummary, "Snowkaze is chatting while testing live context.");
    assert.equal(prompt.recentEvents.length, 100);
    assert.equal(prompt.recentEvents[0].id, "context-7");
    assert.equal(prompt.recentEvents.at(-1).id, "current-message");
    assert.equal(prompt.recentEvents.at(-1).text, "hello snowkaze");
    assert.deepEqual(
      memory.getRecentConversationEvents({ limit: 2 }).map((event) => event.kind),
      ["danmaku", "ai_reply"],
    );
  } finally {
    memory.close();
  }
});

test("AiOrchestrator sends only relevant long-term memories plus style rules to replies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-relevant-memory-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    memory.setStreamSummary("当前直播正在聊重庆天气和旅行。");
    memory.upsertLongTermMemory({
      type: "topic_memory",
      content: "直播间最近经常聊重庆旅游，观众对重庆话题感兴趣。",
      source: "test",
      importance: 4,
      confidence: 0.9,
      status: "active",
    });
    memory.upsertLongTermMemory({
      type: "topic_memory",
      content: "直播间也讨论过纳西妲配队。",
      source: "test",
      importance: 5,
      confidence: 0.9,
      status: "active",
    });
    memory.upsertLongTermMemory({
      type: "style_memory",
      content: "雪风回复要短一点，像正在直播聊天。",
      source: "test",
      importance: 3,
      confidence: 0.8,
      status: "active",
    });

    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return "重庆的话，雪风记得大家最近挺爱聊这个。";
      },
    };
    const queue = new ReplyQueue({
      executeSegment: async () => {},
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "reply with useful memory",
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onDanmaku({
      id: "memory-topic-message",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "重庆天气怎么样，适合去玩吗",
      receivedAt: "2026-06-16T02:00:00.000Z",
      source: "bilibili",
      status: "unclaimed",
    });

    const prompt = JSON.parse(completeCalls[0].messages[1].content);

    assert.deepEqual(
      prompt.longTermMemories.map((memory) => memory.type),
      ["style_memory", "topic_memory"],
    );
    assert.equal(prompt.longTermMemories[1].content.includes("重庆旅游"), true);
    assert.equal(
      prompt.longTermMemories.some((memory) => memory.content.includes("纳西妲")),
      false,
    );
  } finally {
    memory.close();
  }
});

test("AiOrchestrator asks AI to judge room entries while online snapshots stay passive", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-events-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return JSON.stringify({
          action: "wait",
          messageIds: [],
          targetUserId: "",
          waitSeconds: 5,
          reason: "room entry does not need a spoken reply yet",
        });
      },
    };
    const queue = new ReplyQueue({
      executeSegment: async () => {},
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: true,
            model: "deepseek-reasoner",
            persona: "judge whether to speak naturally",
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onLiveEvent({
      id: "online-1",
      roomId: "123456",
      kind: "online_snapshot",
      text: "在线榜参考：viewer-a、viewer-b",
      receivedAt: "2026-06-16T02:00:00.000Z",
      source: "bilibili",
      actionable: false,
    });

    assert.equal(completeCalls.length, 0);

    await orchestrator.onLiveEvent({
      id: "enter-1",
      roomId: "123456",
      kind: "room_enter",
      userId: "u1",
      userName: "viewer-a",
      text: "viewer-a 进入了直播间",
      receivedAt: "2026-06-16T02:00:01.000Z",
      source: "bilibili",
      actionable: true,
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 1);
    const prompt = JSON.parse(completeCalls[0].messages[1].content);
    assert.equal(prompt.recentMessages[0].kind, "room_enter");
    assert.equal(prompt.recentMessages[0].id, "enter-1");
    assert.equal(prompt.recentEvents[0].kind, "online_snapshot");
    assert.equal(prompt.recentEvents[0].text, "在线榜参考：viewer-a、viewer-b");
  } finally {
    memory.close();
  }
});

test("AiOrchestrator sends follow and gift events to director judgment", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bridge-ai-social-events-"),
  );
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return JSON.stringify({
          action: "wait",
          messageIds: [],
          targetUserId: "",
          waitSeconds: 5,
          reason: "social event acknowledged in context",
        });
      },
    };
    const queue = new ReplyQueue({
      executeSegment: async () => {},
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: true,
            model: "deepseek-reasoner",
            persona: "judge follows and gifts naturally",
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onLiveEvent({
      id: "follow-1",
      roomId: "123456",
      kind: "follow",
      userId: "u-follow",
      userName: "viewer-follow",
      text: "viewer-follow 关注了直播间",
      receivedAt: "2026-06-16T02:00:02.000Z",
      source: "bilibili",
      actionable: true,
      status: "unclaimed",
    });
    await orchestrator.onLiveEvent({
      id: "gift-1",
      roomId: "123456",
      kind: "gift",
      userId: "u-gift",
      userName: "viewer-gift",
      text: "viewer-gift sent flower x3",
      receivedAt: "2026-06-16T02:00:03.000Z",
      source: "bilibili",
      actionable: true,
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 2);
    const followPrompt = JSON.parse(completeCalls[0].messages[1].content);
    const giftPrompt = JSON.parse(completeCalls[1].messages[1].content);
    assert.equal(followPrompt.recentMessages[0].kind, "follow");
    assert.equal(followPrompt.recentMessages[0].id, "follow-1");
    assert.deepEqual(
      giftPrompt.recentMessages.map((message) => [message.kind, message.id]),
      [
        ["follow", "follow-1"],
        ["gift", "gift-1"],
      ],
    );
  } finally {
    memory.close();
  }
});

test("AiOrchestrator replies to the oldest pending event when director omits message ids", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-director-fallback-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return completeCalls.length === 1
          ? JSON.stringify({
              action: "reply",
              messageIds: [],
              targetUserId: "",
              waitSeconds: 0,
              reason: "reply but forgot ids",
            })
          : "fallback reply";
      },
    };
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => {
        executed.push(segment.text);
      },
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: true,
            model: "deepseek-reasoner",
            persona: "reply naturally",
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
    });

    await orchestrator.onLiveEvent({
      id: "browser-message-1",
      roomId: "123456",
      kind: "danmaku",
      userId: "",
      userName: "雪风智乃",
      text: "雪风能看到吗",
      receivedAt: "2026-06-16T02:00:00.000Z",
      source: "bilibili-page",
      actionable: true,
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 2);
    assert.deepEqual(executed, ["fallback reply"]);
    assert.equal(memory.getUnclaimedMessages({ limit: 10 }).length, 0);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator auto-summarizes memory after configured short-term events", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-auto-summary-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return JSON.stringify({
          shortTermSummary: "直播间正在测试自动记忆总结。",
          memoryCandidates: [
            {
              type: "topic_memory",
              content: "观众在测试雪风是否能形成直播情景记忆。",
              importance: 3,
              confidence: 0.8,
              reason: "测试话题连续出现",
              rememberLongTerm: true,
            },
          ],
          styleAdjustments: [],
        });
      },
    };
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "remember live context",
            memorySummaryInterval: 2,
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue: new ReplyQueue({ executeSegment: async () => {}, wait: async () => {} }),
      receiver,
    });

    await orchestrator.onLiveEvent({
      id: "passive-1",
      roomId: "123456",
      kind: "online_snapshot",
      text: "online viewers: viewer-a",
      receivedAt: "2026-06-18T00:00:00.000Z",
      source: "bilibili",
      actionable: false,
    });
    await orchestrator.onLiveEvent({
      id: "passive-2",
      roomId: "123456",
      kind: "online_snapshot",
      text: "online viewers: viewer-a, viewer-b",
      receivedAt: "2026-06-18T00:00:01.000Z",
      source: "bilibili",
      actionable: false,
    });

    assert.equal(completeCalls.length, 1);
    assert.equal(memory.getStreamSummary(), "直播间正在测试自动记忆总结。");
    assert.equal(memory.listLongTermMemories({ status: "active" }).length, 1);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator stores MCP search results in short-term memory before replying", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-search-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return completeCalls.length === 1
          ? JSON.stringify({
              useTool: true,
              toolName: "web_search",
              query: "重庆天气",
              reason: "current weather",
              rememberShortTerm: true,
            })
          : "查到了，重庆今天多云。";
      },
    };
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => {
        executed.push(segment.text);
      },
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "reply with current facts",
            tools: {
              webSearch: { endpoint: "https://mcp.example.test" },
            },
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
      searchClientFactory: () => ({
        search: async ({ query }) => ({
          query,
          provider: "tencent-wsa-mcp",
          createdAt: "2026-06-18T00:00:00.000Z",
          results: [
            {
              title: "重庆天气预报",
              url: "https://example.test/weather",
              snippet: "重庆今天多云。",
              source: "weather",
            },
          ],
        }),
      }),
    });

    await orchestrator.onDanmaku({
      id: "weather-message",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "重庆天气怎么样",
      receivedAt: "2026-06-18T00:00:00.000Z",
      source: "bilibili",
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 2);
    const replyPrompt = JSON.parse(completeCalls[1].messages[1].content);
    assert.equal(replyPrompt.toolResults[0].query, "重庆天气");
    assert.equal(replyPrompt.recentEvents.at(-1).kind, "tool_search");
    assert.equal(replyPrompt.recentEvents.at(-1).metadata.query, "重庆天气");
    assert.deepEqual(executed, ["查到了，重庆今天多云。"]);
  } finally {
    memory.close();
  }
});

test("AiOrchestrator skips false memory when MCP search fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-search-fail-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return completeCalls.length === 1
          ? JSON.stringify({
              useTool: true,
              toolName: "web_search",
              query: "重庆天气",
              rememberShortTerm: true,
            })
          : "雪风这边暂时查不到，但可以先按你给的信息聊。";
      },
    };
    const executed = [];
    const queue = new ReplyQueue({
      executeSegment: async (segment) => {
        executed.push(segment.text);
      },
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "reply naturally",
            tools: {
              webSearch: { endpoint: "https://mcp.example.test" },
            },
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
      searchClientFactory: () => ({
        search: async () => {
          throw new Error("MCP unavailable");
        },
      }),
    });

    await orchestrator.onDanmaku({
      id: "weather-message",
      roomId: "123456",
      userId: "u1",
      userName: "viewer-a",
      text: "重庆天气怎么样",
      receivedAt: "2026-06-18T00:00:00.000Z",
      source: "bilibili",
      status: "unclaimed",
    });

    assert.equal(completeCalls.length, 2);
    assert.deepEqual(executed, ["雪风这边暂时查不到，但可以先按你给的信息聊。"]);
    assert.equal(
      memory
        .getRecentConversationEvents({ limit: 10 })
        .some((event) => event.kind === "tool_search"),
      false,
    );
  } finally {
    memory.close();
  }
});

test("AiOrchestrator respects the configured daily MCP search limit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-search-limit-"));
  const memory = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  try {
    const completeCalls = [];
    const aiClient = {
      complete: async (request) => {
        completeCalls.push(request);
        return request.json
          ? JSON.stringify({
              useTool: true,
              toolName: "web_search",
              query: "重庆天气",
              rememberShortTerm: true,
            })
          : `reply ${completeCalls.length}`;
      },
    };
    let searchCalls = 0;
    const queue = new ReplyQueue({
      executeSegment: async () => {},
      wait: async () => {},
    });
    const receiver = new EventTarget();
    receiver.currentStatus = () => ({ connected: true });
    const orchestrator = new AiOrchestrator({
      configProvider: () =>
        normalizeConfig({
          ai: {
            enabled: true,
            directorEnabled: false,
            model: "deepseek-v4-pro",
            persona: "reply naturally",
            tools: {
              dailySearchLimit: 1,
              webSearch: { endpoint: "https://mcp.example.test" },
            },
          },
        }),
      memory,
      secrets: { getAiApiKey: () => "sk-test" },
      aiClient,
      queue,
      receiver,
      searchClientFactory: () => ({
        search: async ({ query }) => {
          searchCalls += 1;
          return {
            query,
            provider: "tencent-wsa-mcp",
            createdAt: new Date().toISOString(),
            results: [{ title: "result", snippet: "snippet" }],
          };
        },
      }),
    });

    for (const id of ["search-limit-1", "search-limit-2"]) {
      await orchestrator.onDanmaku({
        id,
        roomId: "123456",
        userId: "u1",
        userName: "viewer-a",
        text: "重庆天气怎么样",
        receivedAt: "2026-06-18T00:00:00.000Z",
        source: "bilibili",
        status: "unclaimed",
      });
    }

    assert.equal(searchCalls, 1);
    assert.equal(orchestrator.status().searchUsage.searchesToday, 1);
  } finally {
    memory.close();
  }
});

test("parseReplySegments uses natural newlines before fallback splitting", () => {
  assert.deepEqual(
    parseReplySegments("line one\n\nline two", { maxLength: 30 }),
    ["line one", "line two"],
  );
});

test("splitLongSegment prefers punctuation before hard character splitting", () => {
  assert.deepEqual(
    splitLongSegment("first part, second part. third part", 12),
    ["first part,", "second part.", "third part"],
  );
});

test("buildReplyMessages includes persona and selected danmaku", () => {
  const messages = buildReplyMessages({
    persona: "kind streamer",
    streamSummary: "testing tts",
    viewerSummary: "viewer cares about training",
    recentEvents: [{ kind: "danmaku", text: "is it trained" }],
    selectedMessages: [{ userName: "viewer-a", text: "how much data" }],
    outputSummary: "nothing is speaking",
  });
  const text = JSON.stringify(messages);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(text, /kind streamer/);
  assert.match(text, /how much data/);
  assert.match(text, /nothing is speaking/);
});

test("buildReplyMessages layers short-term summary, long-term memories, and tool results", () => {
  const messages = buildReplyMessages({
    persona: "角色设定最高优先级",
    currentTime: {
      localDateTime: "2026-06-18 18:30:00",
      dayPart: "晚上",
      timeZone: "Asia/Shanghai",
    },
    shortTermSummary: "当前直播正在聊重庆天气。",
    recentEvents: [{ kind: "tool_search", text: "搜索：重庆天气" }],
    longTermMemories: [
      {
        type: "topic_memory",
        content: "直播间最近经常聊重庆旅游。",
        importance: 3,
      },
    ],
    toolResults: [
      {
        query: "重庆天气",
        results: [{ title: "重庆天气预报", snippet: "今天多云。" }],
      },
    ],
    selectedMessages: [{ userName: "viewer-a", text: "重庆天气怎么样" }],
    outputSummary: "nothing is speaking",
  });
  const system = messages[0].content;
  const payload = JSON.parse(messages[1].content);

  assert.match(system, /Persona: 角色设定最高优先级/);
  assert.match(system, /实时搜索结果/);
  assert.equal(payload.currentTime.dayPart, "晚上");
  assert.equal(payload.shortTermSummary, "当前直播正在聊重庆天气。");
  assert.equal(payload.longTermMemories[0].type, "topic_memory");
  assert.equal(payload.toolResults[0].query, "重庆天气");
});

test("memory summary parser accepts candidates and style adjustments", async () => {
  const { parseMemorySummaryResult, buildMemorySummaryMessages } = await import(
    "../src/ai-memory-manager.mjs"
  );
  const messages = buildMemorySummaryMessages({
    persona: "雪风要记住重要互动",
    shortTermSummary: "旧摘要",
    recentEvents: [{ id: "event-1", kind: "danmaku", text: "喜欢重庆" }],
    longTermMemories: [],
  });
  const parsed = parseMemorySummaryResult(
    JSON.stringify({
      shortTermSummary: "当前直播正在聊重庆。",
      memoryCandidates: [
        {
          type: "topic_memory",
          content: "观众对重庆旅游感兴趣。",
          sourceEventIds: ["event-1"],
          importance: 3,
          confidence: 0.8,
          reason: "反复出现",
          rememberLongTerm: true,
        },
      ],
      styleAdjustments: ["回答要短一点。"],
    }),
  );

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /长期记忆/);
  assert.equal(parsed.shortTermSummary, "当前直播正在聊重庆。");
  assert.equal(parsed.memoryCandidates[0].rememberLongTerm, true);
  assert.deepEqual(parsed.styleAdjustments, ["回答要短一点。"]);
});

test("AiChatClient posts OpenAI compatible chat completions", async () => {
  let captured;
  const client = new AiChatClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "  hello  " } }] };
        },
      };
    },
  });

  const result = await client.complete({
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
    json: false,
    thinkingEnabled: true,
    thinkingLevel: "high",
    timeoutSeconds: 30,
  });
  const body = JSON.parse(captured.options.body);

  assert.equal(result, "hello");
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(body.model, "deepseek-v4-pro");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.thinking, { type: "enabled", level: "high" });
});

test("AiChatClient posts Anthropic Claude messages", async () => {
  let captured;
  const client = new AiChatClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [
              { type: "text", text: "  snow reply  " },
              { type: "thinking", thinking: "hidden" },
            ],
            usage: {
              cache_read_input_tokens: 128,
              cache_creation_input_tokens: 16,
            },
          };
        },
      };
    },
  });

  const result = await client.complete({
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "You are Snowkaze." },
      { role: "user", content: "hi" },
    ],
    json: true,
    thinkingEnabled: true,
    timeoutSeconds: 30,
  });
  const body = JSON.parse(captured.options.body);

  assert.equal(result, "snow reply");
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["x-api-key"], "sk-ant-test");
  assert.equal(captured.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.max_tokens, 2048);
  assert.match(body.system, /You are Snowkaze/);
  assert.match(body.system, /Return only valid JSON/);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.response_format, undefined);
  assert.equal(body.thinking, undefined);
  assert.deepEqual(client.cacheStatus(), {
    promptCacheHitTokens: 128,
    promptCacheMissTokens: 16,
  });
});

test("AiChatClient exposes DeepSeek prompt cache usage", async () => {
  const client = new AiChatClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: "cached reply" } }],
          usage: {
            prompt_cache_hit_tokens: 1200,
            prompt_cache_miss_tokens: 35,
          },
        };
      },
    }),
  });

  await client.complete({
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(client.cacheStatus(), {
    promptCacheHitTokens: 1200,
    promptCacheMissTokens: 35,
  });
});

test("AiChatClient normalizes base URL and requests JSON output", async () => {
  let captured;
  const client = new AiChatClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "{}" } }] };
        },
      };
    },
  });

  await client.complete({
    baseUrl: "https://api.deepseek.com/",
    apiKey: "sk-test",
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
    json: true,
  });
  const body = JSON.parse(captured.options.body);

  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("AiChatClient rejects missing credentials and failed responses", async () => {
  const client = new AiChatClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      },
    }),
  });

  await assert.rejects(
    () =>
      client.complete({
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
        model: "deepseek-v4-pro",
        messages: [],
      }),
    /AI API key is not configured/,
  );
  await assert.rejects(
    () =>
      client.complete({
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "",
        messages: [],
      }),
    /AI model is not configured/,
  );
  await assert.rejects(
    () =>
      client.complete({
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "deepseek-v4-pro",
        messages: [],
      }),
    /AI API request failed: HTTP 503/,
  );
});

test("AiMemoryStore schema rejects incomplete core rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const store = new AiMemoryStore(path.join(directory, "memory.sqlite"));

  assert.throws(
    () =>
      store.db
        .prepare(
          `
            INSERT INTO danmaku_messages
              (room_id, user_id, user_name, text, received_at, source, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "room-1",
          "user-1",
          "viewer-a",
          "missing id",
          "2026-06-16T01:02:03.000Z",
          "bilibili",
          "unclaimed",
        ),
    /NOT NULL/,
  );
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO danmaku_messages (id) VALUES (?)")
        .run("bad-message"),
    /NOT NULL/,
  );
  assert.throws(
    () =>
      store.db
        .prepare(
          `
            INSERT INTO reply_tasks
              (source, source_message_ids, original_reply, status)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run("ai", "[]", "", "queued"),
    /NOT NULL/,
  );
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO reply_tasks (id, status) VALUES (?, ?)")
        .run("bad-task", "queued"),
    /NOT NULL/,
  );
  store.createReplyTask({
    id: "task-for-segment-schema",
    source: "ai",
    sourceMessageIds: [],
    originalReply: "",
    status: "queued",
  });
  assert.throws(
    () =>
      store.db
        .prepare(
          `
            INSERT INTO reply_segments
              (task_id, segment_index, text, status)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run("task-for-segment-schema", 0, "missing id", "queued"),
    /NOT NULL/,
  );
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO reply_segments (id, task_id) VALUES (?, ?)")
        .run("bad-segment", "missing-task"),
    /NOT NULL/,
  );

  store.close();
});

test("AiMemoryStore upgrades lax legacy tables", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const dbPath = path.join(directory, "memory.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE danmaku_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      user_id TEXT,
      user_name TEXT,
      text TEXT,
      received_at TEXT,
      source TEXT,
      status TEXT DEFAULT 'unclaimed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reply_tasks (
      id TEXT PRIMARY KEY,
      source TEXT,
      target_user_id TEXT,
      target_user_name TEXT,
      source_message_ids TEXT DEFAULT '[]',
      original_reply TEXT DEFAULT '',
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reply_segments (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      segment_index INTEGER,
      text TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy
    .prepare(
      `
        INSERT INTO danmaku_messages
          (id, room_id, user_id, user_name, text, received_at, source, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "legacy-message",
      "room-1",
      "user-1",
      "viewer-a",
      "legacy text",
      "2026-06-16T01:02:03.000Z",
      "bilibili",
      "unclaimed",
    );
  legacy
    .prepare("INSERT INTO danmaku_messages (id, text) VALUES (?, ?)")
    .run(null, "drop incomplete message");
  legacy
    .prepare(
      `
        INSERT INTO reply_tasks
          (id, source, target_user_id, target_user_name, source_message_ids, original_reply, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "legacy-task",
      "ai",
      "user-1",
      "viewer-a",
      JSON.stringify(["legacy-message"]),
      "legacy reply",
      "queued",
    );
  legacy
    .prepare("INSERT INTO reply_tasks (id, source, status) VALUES (?, ?, ?)")
    .run(null, "ai", "queued");
  legacy
    .prepare(
      `
        INSERT INTO reply_segments
          (id, task_id, segment_index, text, status)
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run("legacy-task-0", "legacy-task", 0, "legacy reply", "queued");
  legacy
    .prepare("INSERT INTO reply_segments (id, task_id, text) VALUES (?, ?, ?)")
    .run(null, "legacy-task", "drop incomplete segment");
  legacy.close();

  const store = new AiMemoryStore(dbPath);

  assert.deepEqual(
    store.getUnclaimedMessages({ limit: 10 }).map((message) => message.id),
    ["legacy-message"],
  );
  assert.deepEqual(
    store.getQueuedSegments().map((segment) => segment.id),
    ["legacy-task-0"],
  );
  assert.deepEqual(store.getReplyTask("legacy-task").sourceMessageIds, [
    "legacy-message",
  ]);
  assert.throws(
    () =>
      store.db
        .prepare(
          `
            INSERT INTO danmaku_messages
              (room_id, user_id, user_name, text, received_at, source)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "room-1",
          "user-1",
          "viewer-a",
          "missing id after migration",
          "2026-06-16T01:02:03.000Z",
          "bilibili",
        ),
    /NOT NULL/,
  );
  store.close();
});

test("AiMemoryStore drops legacy reply segments whose task was dropped", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const dbPath = path.join(directory, "memory.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE reply_tasks (
      id TEXT PRIMARY KEY,
      source TEXT,
      source_message_ids TEXT DEFAULT '[]',
      original_reply TEXT DEFAULT '',
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reply_segments (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      segment_index INTEGER,
      text TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy
    .prepare("INSERT INTO reply_tasks (id, source, status) VALUES (?, ?, ?)")
    .run("valid-task", "ai", "queued");
  legacy
    .prepare("INSERT INTO reply_tasks (id, status) VALUES (?, ?)")
    .run("dropped-task", "queued");
  legacy
    .prepare(
      `
        INSERT INTO reply_segments
          (id, task_id, segment_index, text, status)
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run("valid-task-0", "valid-task", 0, "valid segment", "queued");
  legacy
    .prepare(
      `
        INSERT INTO reply_segments
          (id, task_id, segment_index, text, status)
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run("orphan-task-0", "dropped-task", 0, "orphan segment", "queued");
  legacy.close();

  const store = new AiMemoryStore(dbPath);

  assert.deepEqual(store.getQueuedSegments(), [
    {
      id: "valid-task-0",
      taskId: "valid-task",
      segmentIndex: 0,
      text: "valid segment",
      status: "queued",
    },
  ]);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("AiMemoryStore rebuilds child foreign keys after parent table migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ai-memory-"));
  const dbPath = path.join(directory, "memory.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE reply_tasks (
      id TEXT PRIMARY KEY,
      source TEXT,
      target_user_id TEXT,
      target_user_name TEXT,
      source_message_ids TEXT DEFAULT '[]',
      original_reply TEXT DEFAULT '',
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reply_segments (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES reply_tasks(id),
      segment_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy
    .prepare(
      `
        INSERT INTO reply_tasks
          (id, source, target_user_id, target_user_name, source_message_ids, original_reply, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run("legacy-task", "ai", "user-1", "viewer-a", "[]", "reply", "queued");
  legacy
    .prepare(
      `
        INSERT INTO reply_segments
          (id, task_id, segment_index, text, status)
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run("legacy-task-0", "legacy-task", 0, "reply", "queued");
  legacy.close();

  const store = new AiMemoryStore(dbPath);

  assert.deepEqual(
    store.getQueuedSegments().map((segment) => segment.id),
    ["legacy-task-0"],
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    store.db.prepare("PRAGMA foreign_key_list(reply_segments)").all().map(
      (row) => ({
        from: row.from,
        table: row.table,
        to: row.to,
      }),
    ),
    [{ from: "task_id", table: "reply_tasks", to: "id" }],
  );
  store.close();
});

test("normalizeConfig keeps a user-selected caption font", () => {
  const config = normalizeConfig({
    captionTextBox: { fontFamily: '"KaiTi", serif' },
  });

  assert.equal(config.captionTextBox.fontFamily, '"KaiTi", serif');
});

test("resolveManagedTtsPaths uses stable app data files", () => {
  const paths = resolveManagedTtsPaths("C:/AppData/Bridge");

  assert.equal(paths.referenceAudioPath, path.join("C:/AppData/Bridge", "tts", "reference.mp3"));
  assert.equal(paths.apiConfigPath, path.join("C:/AppData/Bridge", "tts", "tts_infer.yaml"));
  assert.equal(
    paths.stdoutPath,
    path.join("C:/AppData/Bridge", "logs", "tts-gradio.stdout.log"),
  );
});

test("buildApiConfigYaml selects the configured Yukikaze models on GPU", () => {
  const config = normalizeConfig({
    tts: {
      gptWeightsPath: "D:/GPT/yukikaze.ckpt",
      sovitsWeightsPath: "D:/SoVITS/yukikaze.pth",
    },
  });

  const yaml = buildApiConfigYaml(config);

  assert.match(yaml, /device: cuda/);
  assert.match(yaml, /version: v2Pro/);
  assert.match(yaml, /t2s_weights_path: "D:\/GPT\/yukikaze\.ckpt"/);
  assert.match(yaml, /vits_weights_path: "D:\/SoVITS\/yukikaze\.pth"/);
});

test("buildGradioLaunchEnvironment starts the native v2Pro WebUI with selected models", () => {
  const config = normalizeConfig({
    tts: {
      gradioEndpoint: "http://127.0.0.1:9988",
      gptSoVitsRoot: "D:/GPT-SoVITS",
      gptWeightsPath: "D:/models/voice.ckpt",
      sovitsWeightsPath: "D:/models/voice.pth",
    },
  });

  const environment = buildGradioLaunchEnvironment(config);

  assert.equal(environment.gpt_path, "D:/models/voice.ckpt");
  assert.equal(environment.sovits_path, "D:/models/voice.pth");
  assert.equal(environment.version, "v2Pro");
  assert.equal(environment.infer_ttswebui, "9988");
  assert.equal(environment.language, "zh_CN");
  assert.equal(environment.is_share, "False");
  assert.equal(environment.is_half, "True");
  assert.equal(
    environment.bert_path,
    path.join(
      "D:/GPT-SoVITS",
      "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
    ),
  );
});

test("resource library separates reference, GPT, and SoVITS files", () => {
  const root = "D:\\2-2-Other\\Yukikaze-Live-AI\\tts\\台词工具资源";
  const paths = resolveResourcePaths(root);

  assert.equal(paths.referenceDirectory, path.join(root, "参考音频"));
  assert.equal(paths.gptDirectory, path.join(root, "GPT模型"));
  assert.equal(paths.sovitsDirectory, path.join(root, "SoVITS模型"));
  assert.equal(
    paths.metadataPath,
    path.join(root, "参考音频", "metadata.json"),
  );
});

test("uniqueDestinationName adds a suffix without replacing existing files", () => {
  assert.equal(uniqueDestinationName(["a.pth"], "a.pth"), "a (2).pth");
  assert.equal(
    uniqueDestinationName(["a.pth", "a (2).pth"], "a.pth"),
    "a (3).pth",
  );
});

test("ResourceLibrary initializes recommended files without modifying sources", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-resources-"));
  const sourceDirectory = path.join(directory, "source");
  const resourceRoot = path.join(directory, "library");
  fs.mkdirSync(sourceDirectory);
  const sources = {
    gpt: path.join(sourceDirectory, "yukikaze_jp-e10.ckpt"),
    sovits: path.join(sourceDirectory, "yukikaze_jp_e8_s96.pth"),
    reference: path.join(sourceDirectory, "舰R日文-169_main_07.mp3"),
  };
  for (const [type, filePath] of Object.entries(sources)) {
    fs.writeFileSync(filePath, `${type}-data`);
  }

  const library = new ResourceLibrary({ resourceRoot });
  const migrated = library.initialize({ defaults: sources });

  assert.equal(fs.readFileSync(sources.gpt, "utf8"), "gpt-data");
  assert.equal(fs.readFileSync(migrated.gptWeightsPath, "utf8"), "gpt-data");
  assert.equal(
    fs.readFileSync(migrated.sovitsWeightsPath, "utf8"),
    "sovits-data",
  );
  assert.equal(
    fs.readFileSync(migrated.refAudioPath, "utf8"),
    "reference-data",
  );
});

test("ResourceLibrary keeps an existing managed copy when the original source is gone", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-existing-"));
  const library = new ResourceLibrary({
    resourceRoot: path.join(directory, "library"),
  });
  fs.mkdirSync(library.paths.gptDirectory, { recursive: true });
  fs.mkdirSync(library.paths.sovitsDirectory, { recursive: true });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  const defaults = {
    gpt: path.join(directory, "missing", "voice.ckpt"),
    sovits: path.join(directory, "missing", "voice.pth"),
    reference: path.join(directory, "missing", "voice.wav"),
  };
  fs.writeFileSync(
    path.join(library.paths.gptDirectory, "voice.ckpt"),
    "gpt",
  );
  fs.writeFileSync(
    path.join(library.paths.sovitsDirectory, "voice.pth"),
    "sovits",
  );
  fs.writeFileSync(
    path.join(library.paths.referenceDirectory, "voice.wav"),
    "audio",
  );

  assert.doesNotThrow(() => library.initialize({ defaults }));
});

test("ResourceLibrary starts an empty library when no bundled defaults exist", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-empty-library-"));
  const library = new ResourceLibrary({
    resourceRoot: path.join(directory, "library"),
  });

  const initialized = library.initialize({ defaults: {} });

  assert.deepEqual(initialized, {
    gptWeightsPath: "",
    sovitsWeightsPath: "",
    refAudioPath: "",
  });
  assert.equal(fs.existsSync(library.paths.gptDirectory), true);
  assert.equal(fs.existsSync(library.paths.sovitsDirectory), true);
  assert.equal(fs.existsSync(library.paths.referenceDirectory), true);
});

test("validateReferenceDuration accepts only three to ten seconds", () => {
  assert.deepEqual(validateReferenceDuration(2.99), {
    ok: false,
    message: "参考音频必须至少 3 秒",
  });
  assert.equal(validateReferenceDuration(3).ok, true);
  assert.equal(validateReferenceDuration(10).ok, true);
  assert.deepEqual(validateReferenceDuration(10.01), {
    ok: false,
    message: "参考音频不能超过 10 秒",
  });
});

test("ResourceLibrary lists only supported files and marks active choices", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-list-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.gptDirectory, { recursive: true });
  fs.mkdirSync(library.paths.sovitsDirectory, { recursive: true });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(library.paths.gptDirectory, "voice.ckpt"), "gpt");
  fs.writeFileSync(path.join(library.paths.gptDirectory, "ignore.txt"), "x");
  fs.writeFileSync(
    path.join(library.paths.sovitsDirectory, "voice.pth"),
    "sovits",
  );
  fs.writeFileSync(
    path.join(library.paths.referenceDirectory, "voice.wav"),
    "audio",
  );

  const resources = library.listResources({
    tts: {
      gptWeightsPath: path.join(library.paths.gptDirectory, "voice.ckpt"),
      sovitsWeightsPath: path.join(library.paths.sovitsDirectory, "voice.pth"),
      refAudioPath: path.join(library.paths.referenceDirectory, "voice.wav"),
    },
  });

  assert.deepEqual(resources.gpt.map((item) => item.name), ["voice.ckpt"]);
  assert.deepEqual(resources.sovits.map((item) => item.name), ["voice.pth"]);
  assert.deepEqual(resources.references.map((item) => item.name), ["voice.wav"]);
  assert.equal(resources.gpt[0].selected, true);
  assert.equal(typeof resources.gpt[0].size, "number");
  assert.equal(typeof resources.gpt[0].modifiedAt, "string");
});

test("ResourceLibrary recognizes only files inside the matching managed folder", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-managed-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.gptDirectory, { recursive: true });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  const managedGpt = path.join(library.paths.gptDirectory, "voice.ckpt");
  const managedReference = path.join(
    library.paths.referenceDirectory,
    "voice.wav",
  );
  const externalGpt = path.join(directory, "external.ckpt");
  fs.writeFileSync(managedGpt, "gpt");
  fs.writeFileSync(managedReference, "audio");
  fs.writeFileSync(externalGpt, "external");

  assert.equal(library.isManagedResource("gpt", managedGpt), true);
  assert.equal(
    library.isManagedResource("reference", managedReference),
    true,
  );
  assert.equal(library.isManagedResource("gpt", externalGpt), false);
  assert.equal(library.isManagedResource("sovits", managedGpt), false);
  assert.equal(
    library.isManagedResource(
      "gpt",
      path.join(library.paths.gptDirectory, "missing.ckpt"),
    ),
    false,
  );
});

test("ResourceLibrary rejects traversal when resolving a reference", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-safe-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(library.paths.referenceDirectory, "safe.wav"),
    "audio",
  );

  assert.throws(
    () => library.resolveReference("../safe.wav"),
    /无效的参考音频文件名/,
  );
  assert.equal(
    library.resolveReference("safe.wav"),
    path.join(library.paths.referenceDirectory, "safe.wav"),
  );
});

test("validateAuxiliaryReferences accepts only decodable managed references", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-aux-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  const primary = path.join(library.paths.referenceDirectory, "primary.wav");
  const auxiliary = path.join(library.paths.referenceDirectory, "aux.wav");
  const outside = path.join(directory, "outside.wav");
  fs.writeFileSync(primary, "primary");
  fs.writeFileSync(auxiliary, "aux");
  fs.writeFileSync(outside, "outside");
  const audioEditor = {
    probeAudio(filePath) {
      return {
        durationSeconds: filePath === auxiliary ? 4.2 : 0,
      };
    },
  };

  const config = normalizeConfig({
    tts: {
      refAudioPath: primary,
      auxRefAudioPaths: [auxiliary, primary, auxiliary],
    },
  });
  assert.deepEqual(
    validateAuxiliaryReferences(config, { library, audioEditor }),
    [auxiliary],
  );
  assert.throws(
    () =>
      validateAuxiliaryReferences(
        normalizeConfig({
          tts: { refAudioPath: primary, auxRefAudioPaths: [outside] },
        }),
        { library, audioEditor },
      ),
    /辅助参考音频不在资源库/,
  );
  assert.throws(
    () =>
      validateAuxiliaryReferences(
        normalizeConfig({
          tts: { refAudioPath: primary, auxRefAudioPaths: [auxiliary] },
        }),
        {
          library,
          audioEditor: {
            probeAudio() {
              return { durationSeconds: 0 };
            },
          },
        },
      ),
    /无法解码/,
  );
});

test("validateTrimRange accepts only three to ten second selections", () => {
  assert.equal(validateTrimRange(0, 2.99).ok, false);
  assert.equal(validateTrimRange(0, 3).ok, true);
  assert.equal(validateTrimRange(0, 10).ok, true);
  assert.equal(validateTrimRange(0, 10.01).ok, false);
  assert.equal(validateTrimRange(4, 3).ok, false);
});

test("buildTrimmedFileName includes exact selection boundaries", () => {
  assert.equal(
    buildTrimmedFileName("舰R日文-169_vow.mp3", 3.1, 7.8),
    "舰R日文-169_vow_3.10-7.80.wav",
  );
});

test("AudioEditor persists reference metadata atomically", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-meta-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(library.paths.referenceDirectory, "voice.wav"),
    "audio",
  );
  const editor = new AudioEditor({
    library,
    gptSoVitsRoot: "D:/unused",
  });

  editor.saveMetadata("voice.wav", {
    promptText: "参考文本",
    promptLang: "ja",
    sourceName: "source.mp3",
    trimStart: 1,
    trimEnd: 5,
    durationSeconds: 4,
  });

  assert.deepEqual(editor.getMetadata("voice.wav"), {
    promptText: "参考文本",
    promptLang: "ja",
    sourceName: "source.mp3",
    trimStart: 1,
    trimEnd: 5,
    durationSeconds: 4,
  });
  assert.equal(
    fs.existsSync(`${library.paths.metadataPath}.tmp`),
    false,
  );
});

test("AudioEditor reads UTF-8 BOM metadata files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-meta-bom-"));
  const library = new ResourceLibrary({ resourceRoot: directory });
  fs.mkdirSync(library.paths.referenceDirectory, { recursive: true });
  fs.writeFileSync(
    library.paths.metadataPath,
    `\uFEFF${JSON.stringify({
      "voice.wav": { promptText: "参考文本", promptLang: "ja" },
    })}`,
    "utf8",
  );
  const editor = new AudioEditor({
    library,
    gptSoVitsRoot: "D:/unused",
  });

  assert.deepEqual(editor.getMetadata("voice.wav"), {
    promptText: "参考文本",
    promptLang: "ja",
  });
});

test("font family names remove registry suffixes and duplicate style entries", () => {
  assert.equal(
    cleanFontFamilyName("Microsoft YaHei & Microsoft YaHei UI (TrueType)"),
    "Microsoft YaHei",
  );
  assert.equal(cleanFontFamilyName("汉仪中黑 197"), "汉仪中黑 197");
  assert.deepEqual(
    normalizeFontFamilies([
      "Noto Sans SC",
      "Microsoft YaHei (TrueType)",
      "Noto Sans SC",
      "  汉仪中黑 197  ",
      "",
    ]),
    ["Microsoft YaHei", "Noto Sans SC", "汉仪中黑 197"],
  );
});

test("test tone is a valid mono PCM wav", () => {
  const wav = createTestToneWav({
    durationSeconds: 0.25,
    sampleRate: 8000,
    frequency: 440,
  });

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.length, 44 + 2000 * 2);
});

test("caption font fitting decreases until content fits or minimum is reached", () => {
  assert.equal(
    fitFontSize({
      preferredSize: 36,
      minimumSize: 18,
      fitsAtSize: (size) => size <= 30,
    }),
    30,
  );
  assert.equal(
    fitFontSize({
      preferredSize: 36,
      minimumSize: 18,
      fitsAtSize: () => false,
    }),
    18,
  );
});

test("buildAudioRoutes supports system, single, and dual output modes", () => {
  assert.deepEqual(buildAudioRoutes({ mode: "system" }), [
    { deviceId: "", label: "系统默认输出" },
  ]);
  assert.deepEqual(
    buildAudioRoutes({
      mode: "single",
      primaryDeviceId: "cable",
      primaryDeviceLabel: "CABLE Input",
    }),
    [{ deviceId: "cable", label: "CABLE Input" }],
  );
  assert.deepEqual(
    buildAudioRoutes({
      mode: "dual",
      primaryDeviceId: "cable",
      primaryDeviceLabel: "CABLE Input",
      monitorDeviceId: "headphones",
      monitorDeviceLabel: "耳机",
    }),
    [
      { deviceId: "cable", label: "CABLE Input" },
      { deviceId: "headphones", label: "耳机" },
    ],
  );
  assert.throws(
    () => buildAudioRoutes({ mode: "single", primaryDeviceId: "" }),
    /请选择主输出设备/,
  );
});

test("normalizeConfig clamps media output volume between zero and one", () => {
  assert.equal(
    normalizeConfig({ audioOutput: { volume: 0.65 } }).audioOutput.volume,
    0.65,
  );
  assert.equal(
    normalizeConfig({ audioOutput: { volume: 2 } }).audioOutput.volume,
    1,
  );
  assert.equal(
    normalizeConfig({ audioOutput: { volume: -1 } }).audioOutput.volume,
    0,
  );
});

test("AudioRouter binds every route before synchronized playback", async () => {
  const events = [];
  const created = [];
  const router = new AudioRouter({
    createAudio(url) {
      const audio = {
        url,
        async setSinkId(deviceId) {
          events.push(`sink:${deviceId}`);
          this.deviceId = deviceId;
        },
        async play() {
          events.push(`play:${this.deviceId}`);
        },
      };
      created.push(audio);
      return audio;
    },
  });

  const result = await router.play("/audio/test.wav", {
    mode: "dual",
    volume: 0.65,
    primaryDeviceId: "cable",
    primaryDeviceLabel: "CABLE Input",
    monitorDeviceId: "headphones",
    monitorDeviceLabel: "耳机",
  });

  assert.equal(created.length, 2);
  assert.deepEqual(events.slice(0, 2), ["sink:cable", "sink:headphones"]);
  assert.deepEqual(new Set(events.slice(2)), new Set([
    "play:cable",
    "play:headphones",
  ]));
  assert.deepEqual(
    created.map((audio) => audio.volume),
    [0.65, 0.65],
  );
  assert.equal(result.outputs.length, 2);
});

test("audio playback gate keeps an AI line pending until the browser is unlocked", () => {
  const gate = new AudioPlaybackGate();
  const voice = {
    id: 12,
    shouldPlay: true,
    audioUrl: "/audio/reply.wav",
    text: "这句台词不能被启用操作吞掉。",
  };

  assert.deepEqual(gate.receive(voice), { type: "pending" });
  assert.deepEqual(gate.unlock(), { type: "play", event: voice });
  gate.markCompleted(voice.id);
  assert.deepEqual(gate.receive(voice), { type: "ignore" });
});

test("playback controller plays a new audio event once after unlock", async () => {
  const played = [];
  const controller = new AudioPlaybackController({
    audioRouter: {
      async play(url) {
        played.push(url);
        return { audios: [] };
      },
    },
    wait: async () => {},
  });
  const event = {
    id: 1,
    shouldPlay: true,
    audioUrl: "/audio/reply.wav",
    audioDurationSeconds: 0,
    text: "测试语音",
  };

  await controller.unlock({ audioOutput: { mode: "system" } });
  controller.receive(event, { audioOutput: { mode: "system" } });
  controller.receive(event, { audioOutput: { mode: "system" } });
  await controller.whenIdle();

  assert.equal(played.length, 1);
});

test("playback controller keeps the global receiver for its default fetch", async () => {
  const originalFetch = globalThis.fetch;
  const receivers = [];
  globalThis.fetch = async function fetchState() {
    receivers.push(this);
    return {
      async json() {
        return {
          ok: true,
          config: { audioOutput: { mode: "system" } },
          audio: { shouldPlay: false },
        };
      },
    };
  };

  try {
    const controller = new AudioPlaybackController({
      audioRouter: { async play() {} },
    });
    await controller.poll();
    assert.deepEqual(receivers, [globalThis]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readWavDurationSeconds reads generated TTS wav length for queue pacing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-wav-duration-"));
  const filePath = path.join(directory, "tone.wav");
  fs.writeFileSync(
    filePath,
    createTestToneWav({ durationSeconds: 1.25, sampleRate: 8000 }),
  );

  assert.equal(readWavDurationSeconds(filePath), 1.25);
  assert.equal(readWavDurationSeconds(path.join(directory, "missing.wav")), 0);
});

test("ReplyQueue waits for the dynamic delay returned by a spoken segment", async () => {
  const events = [];
  const queue = new ReplyQueue({
    executeSegment: async (segment) => {
      events.push(`speak:${segment.text}`);
      return { delaySeconds: segment.text === "first" ? 1.75 : 0 };
    },
    wait: async (seconds) => {
      events.push(`wait:${seconds}`);
    },
  });

  queue.enqueueTask({
    id: "reply",
    segments: [
      { id: "reply-0", text: "first" },
      { id: "reply-1", text: "second" },
    ],
    segmentDelaySeconds: 0,
  });
  await queue.drain();

  assert.deepEqual(events, ["speak:first", "wait:1.75", "speak:second"]);
});
