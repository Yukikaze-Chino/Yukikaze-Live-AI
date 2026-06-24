import { ReferenceAudioEditor } from "/public/audio-editor.js";
import { AudioRouter } from "/public/audio-router.js";
import { AudioPlaybackController } from "/public/audio-playback-controller.js";

const state = {
  config: null,
  resources: { gpt: [], sovits: [], references: [] },
  audioDevices: [],
  fonts: [],
  busy: false,
  aiTestBusy: false,
  musicPollTimer: null,
  lastContextSignature: "",
  lastStatusSummary: "",
};

const nodes = Object.fromEntries(
  [
    "lineInput",
    "sendButton",
    "manualEnableTts",
    "previewButton",
    "clearButton",
    "openBrowserButton",
    "startTtsButton",
    "restartTtsButton",
    "stopTtsButton",
    "applyModelsButton",
    "gptModelSelect",
    "sovitsModelSelect",
    "aiGptModelSelect",
    "aiSovitsModelSelect",
    "saveAiTtsProfileButton",
    "gptModelDetail",
    "sovitsModelDetail",
    "modelChangeNote",
    "importGptButton",
    "importSovitsButton",
    "importReferenceButton",
    "gptFileInput",
    "sovitsFileInput",
    "referenceFileInput",
    "configForm",
    "ttsForm",
    "status",
    "ttsApiStatus",
    "ttsPid",
    "log",
    "captionUrl",
    "captionVisualOnlyUrl",
    "dialogueUrl",
    "logOverlayUrl",
    "audioPlayerUrl",
    "audioPlaybackUnlockButton",
    "audioPlaybackStatus",
    "audioPlaybackOutput",
    "audioPlaybackLine",
    "ttsDialog",
    "ttsError",
    "useReferenceButton",
    "trimReferenceButton",
    "audioOutputForm",
    "audioOutputMode",
    "audioOutputVolume",
    "primaryOutputLabel",
    "monitorOutputLabel",
    "primaryOutputSelect",
    "monitorOutputSelect",
    "audioOutputStatus",
    "musicCollaborationForm",
    "musicStatus",
    "musicOutputModeControls",
    "musicOutputModeStreamOnly",
    "musicOutputModeStreamAndMedia",
    "musicOutputModeMediaOnly",
    "musicOutputStatus",
    "musicStartButton",
    "musicRefreshButton",
    "musicAcceptingButton",
    "musicPlaybackButton",
    "musicSkipButton",
    "musicCurrentSong",
    "musicQueueList",
    "musicRejectList",
    "aiSettingsForm",
    "aiKeyForm",
    "aiKeyStatus",
    "aiSearchKeyForm",
    "aiSearchKeyStatus",
    "tencentSecretId",
    "tencentSecretKey",
    "aiStatusText",
    "aiDebugInfo",
    "aiTtsSummary",
    "aiTtsCurrentText",
    "aiTtsCurrentMeta",
    "aiTtsRecentList",
    "pauseAiButton",
    "resumeAiButton",
    "stopAiButton",
    "clearAiQueueButton",
    "aiTestUserName",
    "aiTestMessage",
    "sendAiTestMessageButton",
    "aiTestStatusText",
    "aiContextClock",
    "aiContextMessages",
    "aiContextSettingsForm",
    "refreshAiContextButton",
    "aiSceneSettingsForm",
    "aiSceneStatus",
    "aiSceneSilence",
    "aiSceneNextCheck",
    "aiSceneQuota",
    "aiSceneVisionState",
    "aiSceneSummary",
    "aiSceneSummaryTime",
    "aiSceneError",
    "testAudioOutputButton",
    "refreshAudioDevicesButton",
    "authorizeAudioDevicesButton",
    "auxReferenceSelect",
    "saveAuxReferencesButton",
    "clearAuxReferencesButton",
    "auxReferenceStatus",
    "fontFamilyInput",
    "fontFamilyList",
    "refreshFontsButton",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

let audioEditor;
const audioRouter = new AudioRouter();
const audioPlaybackController = new AudioPlaybackController({
  audioRouter,
  onState({ status, output, line }) {
    if (status) nodes.audioPlaybackStatus.textContent = status;
    if (output) nodes.audioPlaybackOutput.textContent = output;
    if (line) nodes.audioPlaybackLine.textContent = line;
  },
});

function log(message) {
  const time = new Date().toLocaleTimeString();
  nodes.log.textContent = `[${time}] ${message}\n${nodes.log.textContent}`.slice(
    0,
    12000,
  );
}

function setStatus(message) {
  nodes.status.textContent = message;
}

function reportError(error, prefix = "操作失败") {
  const message = error instanceof Error ? error.message : String(error);
  log(`${prefix}：${message}`);
  setStatus("等待输入");
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

async function uploadResource(type, file) {
  const response = await fetch(
    `/api/resources/import?type=${encodeURIComponent(type)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setNested(target, key, value) {
  const parts = key.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = cursor[part] || {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function readForm(form) {
  const result = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === "radio" && !element.checked) continue;
    let value = element.value;
    if (["number", "range"].includes(element.type)) value = Number(value);
    if (element.type === "checkbox") value = element.checked;
    setNested(result, element.name, value);
  }
  return result;
}

function valueAt(config, key) {
  return key
    .split(".")
    .reduce((cursor, part) => cursor?.[part], config);
}

function ensureSelectValue(select, value) {
  if (
    select.tagName === "SELECT" &&
    !Array.from(select.options).some((option) => option.value === String(value))
  ) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `当前字体：${value}`;
    select.append(option);
  }
}

function fillForm(form, config) {
  for (const element of form.elements) {
    if (!element.name) continue;
    const value = valueAt(config, element.name);
    if (value === undefined || value === null) continue;
    if (element.type === "checkbox") {
      element.checked = Boolean(value);
    } else {
      ensureSelectValue(element, value);
      element.value = value;
    }
  }
  syncSliderOutputs(form);
}

function syncSliderOutputs(form) {
  for (const input of form.querySelectorAll("input[data-output]")) {
    const output = document.querySelector(`#${input.dataset.output}`);
    if (!output) continue;
    output.value =
      input.dataset.format === "percent"
        ? `${Math.round(Number(input.value) * 100)}%`
        : input.value;
  }
}

async function loadConfig() {
  const data = await api("/api/config");
  state.config = data.config;
  nodes.captionUrl.value = data.config.captionSourceUrl;
  nodes.captionVisualOnlyUrl.value = data.config.captionVisualOnlyUrl;
  nodes.dialogueUrl.value = data.config.dialogueSourceUrl;
  nodes.logOverlayUrl.value = data.config.logOverlayUrl;
  nodes.audioPlayerUrl.value = data.config.audioPlayerUrl;
  fillForm(nodes.configForm, data.config);
  fillForm(nodes.ttsForm, data.config);
  fillForm(nodes.audioOutputForm, data.config);
  fillForm(nodes.musicCollaborationForm, data.config);
  fillForm(nodes.aiSettingsForm, data.config);
  fillForm(nodes.aiContextSettingsForm, data.config);
  fillForm(nodes.aiSceneSettingsForm, data.config);
  nodes.audioOutputMode.value = data.config.audioOutput.mode;
  renderAudioOutputMode();
  return data.config;
}

async function saveConfig(partial) {
  const data = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ config: partial }),
  });
  state.config = data.config;
  fillForm(nodes.configForm, data.config);
  fillForm(nodes.ttsForm, data.config);
  fillForm(nodes.audioOutputForm, data.config);
  fillForm(nodes.musicCollaborationForm, data.config);
  fillForm(nodes.aiSettingsForm, data.config);
  fillForm(nodes.aiContextSettingsForm, data.config);
  fillForm(nodes.aiSceneSettingsForm, data.config);
  nodes.captionUrl.value = data.config.captionSourceUrl;
  nodes.captionVisualOnlyUrl.value = data.config.captionVisualOnlyUrl;
  nodes.dialogueUrl.value = data.config.dialogueSourceUrl;
  nodes.logOverlayUrl.value = data.config.logOverlayUrl;
  nodes.audioPlayerUrl.value = data.config.audioPlayerUrl;
  nodes.audioOutputMode.value = data.config.audioOutput.mode;
  renderAudioOutputMode();
  return data.config;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function modelDetails(item) {
  if (!item) return "资源库中没有可用文件";
  return `${formatBytes(item.size)} · ${new Date(
    item.modifiedAt,
  ).toLocaleString()}`;
}

function fillResourceSelect(select, resources) {
  const previousValue = select.value;
  select.replaceChildren();
  for (const item of resources) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.name;
    option.selected =
      item.path === previousValue || (!previousValue && item.selected);
    select.append(option);
  }
  if (!select.value && resources.length > 0) {
    select.value = resources[0].path;
  }
}

function renderModelDetails() {
  nodes.gptModelDetail.textContent = modelDetails(
    state.resources.gpt.find(
      (item) => item.path === nodes.gptModelSelect.value,
    ),
  );
  nodes.sovitsModelDetail.textContent = modelDetails(
    state.resources.sovits.find(
      (item) => item.path === nodes.sovitsModelSelect.value,
    ),
  );
}

function renderModelDirtyState() {
  const dirty =
    nodes.gptModelSelect.value !== state.config.tts.gptWeightsPath ||
    nodes.sovitsModelSelect.value !== state.config.tts.sovitsWeightsPath;
  nodes.applyModelsButton.disabled = !dirty;
  nodes.modelChangeNote.textContent = dirty
    ? "模型选择已更改，应用后会重启 TTS。"
    : "";
  renderModelDetails();
}

async function loadResources({ reloadReference = false } = {}) {
  const data = await api("/api/resources");
  state.resources = data.resources;
  fillResourceSelect(nodes.gptModelSelect, state.resources.gpt);
  fillResourceSelect(nodes.sovitsModelSelect, state.resources.sovits);
  fillResourceSelect(nodes.aiGptModelSelect, state.resources.gpt);
  fillResourceSelect(nodes.aiSovitsModelSelect, state.resources.sovits);
  if (state.config?.ttsProfiles?.ai) {
    nodes.aiGptModelSelect.value = state.config.ttsProfiles.ai.gptWeightsPath;
    nodes.aiSovitsModelSelect.value = state.config.ttsProfiles.ai.sovitsWeightsPath;
  }
  renderModelDirtyState();
  if (audioEditor) {
    audioEditor.setResources(state.resources.references);
    if (reloadReference) await audioEditor.loadSelected();
  }
  renderAuxiliaryReferences();
  return state.resources;
}

async function refreshAfterReferenceChange() {
  await loadConfig();
  await loadResources();
}

async function askTtsFailure(errorText) {
  nodes.ttsError.textContent = errorText;
  nodes.ttsDialog.showModal();
  return new Promise((resolve) => {
    nodes.ttsDialog.addEventListener(
      "close",
      () => resolve(nodes.ttsDialog.returnValue || "cancel"),
      { once: true },
    );
  });
}

async function publish(jobId) {
  const data = await api("/api/publish", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
  if (data.bili?.skipped) {
    log("白框已显示；真实弹幕开关已关闭，本条未发送到直播间。");
  } else if (data.bili?.ok) {
    log(`白框已显示，真实弹幕已发送：${data.job.danmakuText}`);
  } else {
    log(`白框已显示，但真实弹幕失败：${data.bili?.error || "未知错误"}`);
  }
}

function renderAuxiliaryReferences() {
  if (!nodes.auxReferenceSelect || !state.config) return;
  const selectedPaths = new Set(state.config.tts.auxRefAudioPaths || []);
  const primaryPath = state.config.tts.refAudioPath;
  nodes.auxReferenceSelect.replaceChildren();
  for (const item of state.resources.references) {
    if (item.path === primaryPath) continue;
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.name;
    option.selected = selectedPaths.has(item.path);
    nodes.auxReferenceSelect.append(option);
  }
  updateAuxiliaryStatus();
}

function selectedAuxiliaryPaths() {
  return Array.from(nodes.auxReferenceSelect.selectedOptions).map(
    (option) => option.value,
  );
}

function updateAuxiliaryStatus() {
  const count = selectedAuxiliaryPaths().length;
  nodes.auxReferenceStatus.textContent =
    count === 0
      ? "未选择辅助参考音频，使用主参考音频的原始效果"
      : `已选择 ${count} 个辅助参考音频`;
}

function renderFontList() {
  nodes.fontFamilyList.replaceChildren();
  for (const font of state.fonts) {
    const option = document.createElement("option");
    option.value = font;
    option.style.fontFamily = `"${font}"`;
    nodes.fontFamilyList.append(option);
  }
}

async function loadFonts() {
  const data = await api("/api/fonts");
  state.fonts = data.fonts;
  renderFontList();
  log(`已读取 ${state.fonts.length} 个本机字体。`);
}

function renderAudioOutputMode() {
  const mode = nodes.audioOutputMode.value;
  nodes.primaryOutputLabel.classList.toggle("hidden", mode === "system");
  nodes.monitorOutputLabel.classList.toggle("hidden", mode !== "dual");
}

function deviceOptionLabel(select) {
  return select.selectedOptions[0]?.textContent || "";
}

function fillAudioDeviceSelect(select, configuredId, configuredLabel) {
  select.replaceChildren();
  for (const device of state.audioDevices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label;
    option.selected = device.deviceId === configuredId;
    select.append(option);
  }
  if (
    configuredId &&
    !state.audioDevices.some((device) => device.deviceId === configuredId)
  ) {
    const option = document.createElement("option");
    option.value = configuredId;
    option.textContent = `${configuredLabel || "已保存设备"}（当前不可用）`;
    option.selected = true;
    option.dataset.missing = "true";
    select.prepend(option);
  }
}

async function loadAudioDevices({ requestPermission = false } = {}) {
  nodes.audioOutputStatus.textContent = "正在读取设备";
  state.audioDevices = await audioRouter.listOutputDevices({
    requestPermission,
  });
  fillAudioDeviceSelect(
    nodes.primaryOutputSelect,
    state.config.audioOutput.primaryDeviceId,
    state.config.audioOutput.primaryDeviceLabel,
  );
  fillAudioDeviceSelect(
    nodes.monitorOutputSelect,
    state.config.audioOutput.monitorDeviceId,
    state.config.audioOutput.monitorDeviceLabel,
  );
  const namedCount = state.audioDevices.filter(
    (device) => !device.label.startsWith("音频输出 "),
  ).length;
  nodes.audioOutputStatus.textContent = `已读取 ${state.audioDevices.length} 个输出设备`;
  if (state.audioDevices.length > 0 && namedCount === 0) {
    nodes.audioOutputStatus.textContent += "，请授权读取设备名称";
  }
}

function audioOutputFromForm() {
  const mode = nodes.audioOutputMode.value;
  const volume = Number(nodes.audioOutputVolume.value);
  if (mode === "system") {
    return {
      mode,
      volume,
      primaryDeviceId: "",
      primaryDeviceLabel: "",
      monitorDeviceId: "",
      monitorDeviceLabel: "",
    };
  }
  return {
    mode,
    volume,
    primaryDeviceId: nodes.primaryOutputSelect.value,
    primaryDeviceLabel: deviceOptionLabel(nodes.primaryOutputSelect),
    monitorDeviceId:
      mode === "dual" ? nodes.monitorOutputSelect.value : "",
    monitorDeviceLabel:
      mode === "dual" ? deviceOptionLabel(nodes.monitorOutputSelect) : "",
  };
}

function musicOutputModeLabel(mode) {
  return {
    stream_only: "仅直播姬",
    stream_and_media: "直播姬和媒体",
    media_only: "仅媒体",
  }[mode] || "未设置";
}

function musicConfigFromForm() {
  const partial = readForm(nodes.musicCollaborationForm);
  if (partial.music) delete partial.music.outputMode;
  return partial;
}

function formatMusicSong(song) {
  if (!song?.title) return "当前没有播放歌曲";
  return [
    song.title,
    song.artist,
    song.requester ? `点播：${song.requester}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderMusicQueue(items, connected) {
  nodes.musicQueueList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "队列为空";
    nodes.musicQueueList.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("li");
    row.className = "music-queue-item";
    const text = document.createElement("span");
    text.textContent = formatMusicSong(item);
    const actions = document.createElement("span");
    actions.className = "music-queue-actions";
    const top = document.createElement("button");
    top.type = "button";
    top.className = "compact-icon secondary";
    top.textContent = "↑";
    top.title = "置顶这首歌";
    top.setAttribute("aria-label", "置顶这首歌");
    top.disabled = !connected;
    top.addEventListener("click", () => runMusicQueueAction("top", item.index));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "compact-icon secondary";
    remove.textContent = "×";
    remove.title = "从队列删除";
    remove.setAttribute("aria-label", "从队列删除");
    remove.disabled = !connected;
    remove.addEventListener("click", () =>
      runMusicQueueAction("delete", item.index),
    );
    actions.append(top, remove);
    row.append(text, actions);
    nodes.musicQueueList.append(row);
  }
}

function renderMusicRejects(items) {
  nodes.musicRejectList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "没有拒绝记录";
    nodes.musicRejectList.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = [item.requester, item.reason].filter(Boolean).join(" · ");
    nodes.musicRejectList.append(row);
  }
}

function renderMusicCollaboration(payload) {
  const music = payload?.music || {};
  const voiceMeeter = payload?.voiceMeeter || {};
  const collaborationEnabled = Boolean(state.config?.music?.enabled);
  const voiceMeeterEnabled = Boolean(state.config?.music?.voiceMeeter?.enabled);
  const connected = collaborationEnabled && Boolean(music.connected);

  nodes.musicStatus.textContent = connected
    ? `BiliNCM 已连接 · ${music.status || "运行中"}`
    : music.error || "BiliNCM 未连接";
  nodes.musicOutputStatus.textContent = voiceMeeterEnabled
    ? voiceMeeter.ok
      ? `VoiceMeeter 已应用：A1 ${voiceMeeter.A1 ? "开" : "关"}，B1 ${voiceMeeter.B1 ? "开" : "关"}`
      : voiceMeeter.error || "VoiceMeeter 不可用"
    : "VoiceMeeter 协作尚未启用";
  nodes.musicCurrentSong.textContent = formatMusicSong(music.current);
  renderMusicQueue(Array.isArray(music.queue) ? music.queue : [], connected);
  renderMusicRejects(Array.isArray(music.rejects) ? music.rejects : []);
  nodes.musicStartButton.disabled = !collaborationEnabled;
  nodes.musicAcceptingButton.disabled = !connected;
  nodes.musicPlaybackButton.disabled = !connected;
  nodes.musicSkipButton.disabled = !connected;
  nodes.musicOutputModeControls.disabled = !(
    collaborationEnabled && voiceMeeterEnabled && voiceMeeter.ok
  );
  nodes.musicAcceptingButton.textContent = music.accepting
    ? "暂停接收点歌"
    : "开始接收点歌";
  nodes.musicPlaybackButton.textContent = music.playing
    ? "暂停播放"
    : "继续播放";
}

async function refreshMusicCollaboration() {
  try {
    const data = await api("/api/music/status");
    renderMusicCollaboration(data);
    return data;
  } catch (error) {
    nodes.musicStatus.textContent =
      error instanceof Error ? error.message : String(error);
    nodes.musicOutputStatus.textContent = "无法读取共享音频状态";
    return null;
  }
}

function restartMusicPolling() {
  if (state.musicPollTimer) window.clearInterval(state.musicPollTimer);
  const seconds = Math.min(
    30,
    Math.max(1, Number(state.config?.music?.biliNcm?.pollIntervalSeconds || 2)),
  );
  state.musicPollTimer = window.setInterval(refreshMusicCollaboration, seconds * 1000);
}

async function saveMusicCollaboration(event) {
  event.preventDefault();
  await saveConfig(musicConfigFromForm());
  restartMusicPolling();
  await refreshMusicCollaboration();
  log("点歌协作设置已保存；保存操作没有启动 BiliNCM 或改变输出模式。");
}

async function runMusicCommand(path, body = {}) {
  const result = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  await refreshMusicCollaboration();
  return result;
}

async function runMusicQueueAction(action, index) {
  try {
    await runMusicCommand("/api/music/queue-action", { action, index });
    log(`点歌队列操作已完成：${action}`);
  } catch (error) {
    reportError(error, "点歌队列操作失败");
  }
}

async function setMusicOutputMode(mode) {
  try {
    const data = await api("/api/music/output-mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    state.config = data.config;
    fillForm(nodes.musicCollaborationForm, state.config);
    restartMusicPolling();
    await refreshMusicCollaboration();
    log(`共享音频模式已应用：${musicOutputModeLabel(mode)}`);
  } catch (error) {
    fillForm(nodes.musicCollaborationForm, state.config);
    reportError(error, "VoiceMeeter 输出模式未应用");
  }
}

function collectAiConfig() {
  return readForm(nodes.aiSettingsForm);
}

function formatAiStatus(ai) {
  const queue = ai.queue || {};
  if (ai.running) {
    return `AI 已运行，队列 ${queue.queuedSegments || 0} 条`;
  }
  if (queue.paused) {
    return `AI 已暂停，队列 ${queue.queuedSegments || 0} 条`;
  }
  return "AI 未运行";
}

const aiTtsStatusLabels = {
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

function formatAiTtsTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

function renderAiTtsStatus(tts) {
  const current = tts?.current || null;
  const recent = Array.isArray(tts?.recent) ? tts.recent : [];
  nodes.aiTtsSummary.textContent = current
    ? "雪风正在生成 TTS"
    : recent.length
      ? `最近生成 ${recent.length} 条`
      : "等待雪风生成语音";
  nodes.aiTtsCurrentText.textContent = current?.text || "无正在生成的句子";
  nodes.aiTtsCurrentMeta.textContent = current
    ? `${aiTtsStatusLabels[current.status] || current.status} · ${formatAiTtsTime(current.startedAt)}`
    : "输出路径会在完成后显示";

  nodes.aiTtsRecentList.replaceChildren();
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.textContent = "还没有 AI TTS 输出。";
    nodes.aiTtsRecentList.append(empty);
    return;
  }

  for (const entry of recent) {
    const item = document.createElement("article");
    item.className = `ai-tts-item ${entry.status || ""}`;
    const title = document.createElement("strong");
    title.textContent = entry.text || "空句子";
    const meta = document.createElement("small");
    meta.textContent = `${aiTtsStatusLabels[entry.status] || entry.status || "未知"} · ${formatAiTtsTime(entry.finishedAt || entry.startedAt)}`;
    const output = document.createElement("code");
    output.textContent = entry.audioPath || entry.audioUrl || entry.error || "没有输出文件";
    item.append(title, meta, output);
    nodes.aiTtsRecentList.append(item);
  }
}

async function refreshAiStatus() {
  try {
    const data = await api("/api/ai/status");
    nodes.aiKeyStatus.textContent = data.secrets?.hasAiApiKey
      ? "密钥已配置"
      : "未配置密钥";
    nodes.aiSearchKeyStatus.textContent = data.secrets?.hasTencentCloudCredentials
      ? "搜索密钥已配置"
      : "搜索密钥未配置";
    nodes.aiStatusText.textContent = formatAiStatus(data.ai);
    nodes.aiDebugInfo.textContent = JSON.stringify(data.ai, null, 2);
    renderAiTtsStatus(data.tts);
    renderAiScene(data.scene || data.ai?.scene);
  } catch (error) {
    nodes.aiStatusText.textContent = "AI 状态读取失败";
    nodes.aiDebugInfo.textContent =
      error instanceof Error ? error.message : String(error);
    renderAiTtsStatus({ recent: [] });
  }
}

function formatSceneTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString();
}

function renderAiScene(scene) {
  if (!scene || !nodes.aiSceneStatus) return;
  const vision = scene.vision || {};
  const settings = state.config?.ai?.scene || {};
  const visionSettings = settings.vision || {};
  nodes.aiSceneStatus.textContent = vision.verified
    ? "图像输入已验证"
    : "图像输入未验证";
  nodes.aiSceneSilence.textContent = Number.isFinite(scene.silenceSeconds)
    ? `${scene.silenceSeconds} 秒`
    : "等待真人互动";
  nodes.aiSceneNextCheck.textContent = formatSceneTime(scene.nextIdleCheckAt);
  nodes.aiSceneQuota.textContent = `${vision.usedCaptures || 0} / ${visionSettings.maxCapturesPerWindow || 0} 次`;
  nodes.aiSceneVisionState.textContent = vision.verified
    ? "可以请求受控读取"
    : "不会上传屏幕";
  nodes.aiSceneSummary.textContent = vision.lastSummary || "暂无文字摘要";
  nodes.aiSceneSummaryTime.textContent = formatSceneTime(vision.lastSummaryAt);
  nodes.aiSceneError.textContent = scene.lastError || "";
}

async function refreshAiScene() {
  try {
    const data = await api("/api/ai/scene");
    renderAiScene(data.scene);
  } catch (error) {
    if (nodes.aiSceneError) {
      nodes.aiSceneError.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }
}

const contextKindLabels = {
  danmaku: "观众",
  room_enter: "进房",
  follow: "关注",
  share: "分享",
  gift: "礼物",
  online_snapshot: "在线榜",
  guard: "舰长",
  super_chat: "醒目留言",
  like: "点赞",
  manual_line: "手动台词",
  ai_reply: "雪风",
};

function classifyContextEvent(event) {
  if (event.kind === "ai_reply" || event.kind === "manual_line") {
    return "snowkaze";
  }
  if (event.kind === "danmaku") return "viewer";
  return "system";
}

function renderAiContextClock(currentTime) {
  if (!nodes.aiContextClock) return;
  if (!currentTime?.localDateTime) {
    nodes.aiContextClock.textContent = "雪风当前时间：等待后端时间";
    return;
  }
  nodes.aiContextClock.textContent = [
    `雪风当前时间：${currentTime.localDateTime}`,
    currentTime.weekday,
    currentTime.dayPart,
    currentTime.timeZone,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderAiContext(context) {
  renderAiContextClock(context?.currentTime);
  const events = Array.isArray(context?.events) ? context.events : [];
  const signature = JSON.stringify(events.map((event) => [
    event.id,
    event.kind,
    event.text,
    event.localTime,
    event.ageLabel,
  ]));
  if (signature === state.lastContextSignature) return;
  state.lastContextSignature = signature;
  nodes.aiContextMessages.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "ai-context-empty";
    empty.textContent = "暂时没有可见上下文。";
    nodes.aiContextMessages.append(empty);
    return;
  }

  for (const event of events) {
    const item = document.createElement("article");
    item.className = `ai-message ${classifyContextEvent(event)}`;
    const meta = document.createElement("div");
    meta.className = "ai-message-meta";
    const kind = contextKindLabels[event.kind] || event.kind || "事件";
    const name = event.userName || kind;
    const time = [event.localTime, event.ageLabel].filter(Boolean).join(" · ");
    meta.textContent = `${name} · ${kind}${time ? ` · ${time}` : ""}`;
    const text = document.createElement("div");
    text.className = "ai-message-text";
    text.textContent = event.text || "";
    item.append(meta, text);
    nodes.aiContextMessages.append(item);
  }
  nodes.aiContextMessages.scrollTop = nodes.aiContextMessages.scrollHeight;
}

async function refreshAiContext() {
  try {
    const data = await api("/api/ai/context");
    renderAiContext(data.context);
  } catch (error) {
    nodes.aiContextMessages.textContent =
      error instanceof Error ? error.message : String(error);
  }
}

async function runAiControl(action) {
  const labels = {
    pause: "暂停",
    resume: "恢复",
    stop: "停止",
    clear: "清空队列",
  };
  try {
    setStatus(`AI ${labels[action] || action}中`);
    await api("/api/ai/control", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await refreshAiStatus();
    log(`AI ${labels[action] || action}完成。`);
  } catch (error) {
    reportError(error, "AI 控制失败");
  } finally {
    setStatus("等待输入");
  }
}

async function sendAiTestMessage() {
  if (state.aiTestBusy) return;
  const text = nodes.aiTestMessage.value.trim();
  if (!text) {
    nodes.aiTestMessage.focus();
    return;
  }

  state.aiTestBusy = true;
  nodes.sendAiTestMessageButton.disabled = true;
  nodes.aiTestStatusText.textContent = "正在发送测试消息";
  try {
    const userName = nodes.aiTestUserName.value.trim() || "测试观众";
    await api("/api/ai/test-message", {
      method: "POST",
      body: JSON.stringify({ userName, text }),
    });
    nodes.aiTestMessage.value = "";
    nodes.aiTestStatusText.textContent = "测试消息已进入 AI 判断";
    log(`离线测试消息已发送给雪风：${userName}：${text}`);
    await refreshAiStatus();
    await refreshAiContext();
  } catch (error) {
    nodes.aiTestStatusText.textContent = "测试消息发送失败";
    reportError(error, "AI 离线测试失败");
  } finally {
    state.aiTestBusy = false;
    nodes.sendAiTestMessageButton.disabled = false;
    nodes.aiTestMessage.focus();
  }
}

async function createJobWithoutTts(text) {
  const data = await api("/api/create-job", {
    method: "POST",
    body: JSON.stringify({ text, source: "manual", enableTts: false }),
  });
  return data.job;
}

async function submitLine() {
  if (state.busy) return;
  const text = nodes.lineInput.value.trim();
  if (!text) {
    nodes.lineInput.focus();
    return;
  }

  state.busy = true;
  nodes.sendButton.disabled = true;
  try {
    const enableTts = nodes.manualEnableTts.checked;
    if (!enableTts) {
      setStatus("正在发布人工台词");
      const job = await createJobWithoutTts(text);
      await publish(job.id);
      nodes.lineInput.value = "";
      setStatus("等待输入");
      return;
    }
    setStatus("正在生成 TTS");
    log(`开始合成：${text}`);
    let prepared;
    try {
      prepared = await api("/api/prepare", {
        method: "POST",
        body: JSON.stringify({ text, source: "manual", enableTts: true }),
      });
    } catch (error) {
      const jobId = error.data?.job?.id;
      const choice = await askTtsFailure(error.message);
      if (choice === "retry") {
        state.busy = false;
        nodes.sendButton.disabled = false;
        await submitLine();
        return;
      }
      if (choice === "skip") {
        const job = jobId ? { id: jobId } : await createJobWithoutTts(text);
        await publish(job.id);
        nodes.lineInput.value = "";
      }
      setStatus("等待输入");
      return;
    }

    setStatus("正在发布");
    await publish(prepared.job.id);
    nodes.lineInput.value = "";
    log("白框和语音已交给控制台播放器按同一任务顺序输出。");
    setStatus("等待输入");
  } catch (error) {
    reportError(error, "发送失败");
  } finally {
    state.busy = false;
    nodes.sendButton.disabled = false;
    nodes.lineInput.focus();
  }
}

function updateTtsStatus(tts) {
  if (tts.starting) {
    nodes.ttsApiStatus.textContent = "TTS 正在启动";
  } else if (tts.ok) {
    nodes.ttsApiStatus.textContent = "TTS 已连接";
  } else {
    nodes.ttsApiStatus.textContent = `TTS 未连接：${tts.message}`;
  }
  nodes.ttsPid.textContent = tts.pid ? `PID ${tts.pid}` : "";
}

async function runTtsAction(action, label) {
  setStatus(`${label}中`);
  const buttons = [
    nodes.startTtsButton,
    nodes.restartTtsButton,
    nodes.stopTtsButton,
  ];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const data = await api(`/api/tts/${action}`, {
      method: "POST",
      body: "{}",
    });
    updateTtsStatus(data.tts);
    log(`${label}完成：${data.tts.message}`);
  } catch (error) {
    reportError(error, `${label}失败`);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    setStatus("等待输入");
  }
}

async function importFile(type, input, preferredSelect = null) {
  const file = input.files?.[0];
  if (!file) return;
  setStatus(`正在导入 ${file.name}`);
  try {
    const data = await uploadResource(type, file);
    await loadResources();
    if (preferredSelect) preferredSelect.value = data.imported.path;
    if (type === "reference") {
      audioEditor.setResources(state.resources.references);
      audioEditor.select.value = data.imported.name;
      await audioEditor.loadSelected();
    } else {
      renderModelDirtyState();
    }
    log(`已导入：${data.imported.path}`);
  } catch (error) {
    reportError(error, "导入失败");
  } finally {
    input.value = "";
    setStatus("等待输入");
  }
}

function bindEvents() {
  nodes.sendButton.addEventListener("click", submitLine);
  nodes.lineInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitLine();
    }
  });
  nodes.previewButton.addEventListener("click", async () => {
    try {
      const text =
        nodes.lineInput.value.trim() ||
        "这是白框预览文字，可以用来调整字体和位置。";
      await api("/api/preview-caption", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      log("白框预览已发送，不会发送真实弹幕。");
    } catch (error) {
      reportError(error, "预览失败");
    }
  });
  nodes.clearButton.addEventListener("click", async () => {
    try {
      await api("/api/clear-caption", { method: "POST", body: "{}" });
      log("白框已清空。");
    } catch (error) {
      reportError(error, "清空失败");
    }
  });
  nodes.openBrowserButton.addEventListener("click", async () => {
    setStatus("正在打开专用网页");
    try {
      const result = await api("/api/browser/open", {
        method: "POST",
        body: "{}",
      });
      log(`专用网页已打开：${result.url}`);
    } catch (error) {
      reportError(error, "打开专用网页失败");
    } finally {
      setStatus("等待输入");
    }
  });

  nodes.aiSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveConfig(collectAiConfig());
      await refreshAiStatus();
      log("AI 自动回复设置已保存。");
    } catch (error) {
      reportError(error, "保存 AI 设置失败");
    }
  });
  nodes.aiKeyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = readForm(nodes.aiKeyForm);
      await api("/api/ai/key", {
        method: "POST",
        body: JSON.stringify(data),
      });
      nodes.aiKeyForm.reset();
      await refreshAiStatus();
      log("AI API Key 已保存。");
    } catch (error) {
      reportError(error, "保存 AI API Key 失败");
    }
  });
  nodes.aiSearchKeyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = readForm(nodes.aiSearchKeyForm);
      await api("/api/ai/search-credentials", {
        method: "POST",
        body: JSON.stringify(data),
      });
      nodes.aiSearchKeyForm.reset();
      await refreshAiStatus();
      log("搜索密钥已保存。");
    } catch (error) {
      reportError(error, "保存搜索密钥失败");
    }
  });
  nodes.pauseAiButton.addEventListener("click", () => runAiControl("pause"));
  nodes.resumeAiButton.addEventListener("click", () => runAiControl("resume"));
  nodes.stopAiButton.addEventListener("click", () => runAiControl("stop"));
  nodes.clearAiQueueButton.addEventListener("click", () =>
    runAiControl("clear"),
  );
  nodes.sendAiTestMessageButton.addEventListener("click", sendAiTestMessage);
  nodes.aiTestMessage.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendAiTestMessage();
    }
  });
  nodes.refreshAiContextButton.addEventListener("click", refreshAiContext);
  nodes.aiContextSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveConfig(readForm(nodes.aiContextSettingsForm));
      state.lastContextSignature = "";
      await refreshAiContext();
      log("AI chat 上下文设置已保存。");
    } catch (error) {
      reportError(error, "保存 AI chat 上下文设置失败");
    }
  });
  nodes.aiSceneSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveConfig(readForm(nodes.aiSceneSettingsForm));
      await refreshAiScene();
      await refreshAiStatus();
      log("直播情景设置已保存。");
    } catch (error) {
      reportError(error, "保存直播情景设置失败");
    }
  });

  nodes.musicCollaborationForm.addEventListener(
    "submit",
    async (event) => {
      try {
        await saveMusicCollaboration(event);
      } catch (error) {
        reportError(error, "保存点歌协作设置失败");
      }
    },
  );
  nodes.musicStartButton.addEventListener("click", async () => {
    try {
      const result = await runMusicCommand("/api/music/start");
      log(`BiliNCM 已启动，进程 ID：${result.pid}`);
    } catch (error) {
      reportError(error, "启动 BiliNCM 失败");
    }
  });
  nodes.musicRefreshButton.addEventListener("click", refreshMusicCollaboration);
  nodes.musicAcceptingButton.addEventListener("click", async () => {
    try {
      await runMusicCommand("/api/music/toggle-accepting");
    } catch (error) {
      reportError(error, "切换接收点歌失败");
    }
  });
  nodes.musicPlaybackButton.addEventListener("click", async () => {
    try {
      await runMusicCommand("/api/music/toggle-playback");
    } catch (error) {
      reportError(error, "切换点歌播放失败");
    }
  });
  nodes.musicSkipButton.addEventListener("click", async () => {
    try {
      await runMusicCommand("/api/music/queue-action", {
        action: "skip_current",
      });
    } catch (error) {
      reportError(error, "跳过当前歌曲失败");
    }
  });
  nodes.musicOutputModeControls.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.checked) {
      setMusicOutputMode(input.value);
    }
  });

  nodes.audioOutputMode.addEventListener("change", renderAudioOutputMode);
  nodes.audioOutputVolume.addEventListener("input", () =>
    syncSliderOutputs(nodes.audioOutputForm),
  );
  nodes.audioOutputForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const audioOutput = audioOutputFromForm();
      await saveConfig({ audioOutput });
      nodes.audioOutputStatus.textContent = "音频输出设置已保存";
      log(`音频输出模式已保存：${audioOutput.mode}`);
    } catch (error) {
      reportError(error, "保存音频输出失败");
    }
  });
  nodes.testAudioOutputButton.addEventListener("click", async () => {
    try {
      setStatus("正在测试音频输出");
      await audioPlaybackController.playTest({
        audioOutput: audioOutputFromForm(),
      });
      nodes.audioOutputStatus.textContent = "测试音已播放";
      log("测试音已发送到当前选择的输出设备。");
    } catch (error) {
      reportError(error, "测试音频输出失败");
    } finally {
      setStatus("等待输入");
    }
  });
  nodes.audioPlaybackUnlockButton.addEventListener("click", async () => {
    try {
      await audioPlaybackController.unlock(state.config, {
        testAudioUrl: "/api/audio/test-tone",
      });
      log("雪风音频播放器已启用。控制台保持打开即可持续播放。");
    } catch (error) {
      reportError(error, "启用雪风音频播放失败");
    }
  });
  nodes.refreshAudioDevicesButton.addEventListener("click", async () => {
    try {
      await loadAudioDevices();
    } catch (error) {
      reportError(error, "刷新音频设备失败");
    }
  });
  nodes.authorizeAudioDevicesButton.addEventListener("click", async () => {
    try {
      await loadAudioDevices({ requestPermission: true });
      log("音频设备名称授权完成。");
    } catch (error) {
      reportError(error, "音频设备授权失败");
    }
  });

  nodes.startTtsButton.addEventListener("click", () =>
    runTtsAction("start", "启动 TTS"),
  );
  nodes.restartTtsButton.addEventListener("click", () =>
    runTtsAction("restart", "重启 TTS"),
  );
  nodes.stopTtsButton.addEventListener("click", () =>
    runTtsAction("stop", "停止 TTS"),
  );

  for (const select of [
    nodes.gptModelSelect,
    nodes.sovitsModelSelect,
  ]) {
    select.addEventListener("change", renderModelDirtyState);
  }
  nodes.applyModelsButton.addEventListener("click", async () => {
    setStatus("正在应用模型");
    try {
      await saveConfig({
        tts: {
          gptWeightsPath: nodes.gptModelSelect.value,
          sovitsWeightsPath: nodes.sovitsModelSelect.value,
        },
      });
      await runTtsAction("restart", "重启 TTS");
      await loadResources();
      log("模型已应用。");
    } catch (error) {
      reportError(error, "应用模型失败");
    } finally {
      setStatus("等待输入");
    }
  });
  nodes.saveAiTtsProfileButton.addEventListener("click", async () => {
    try {
      await saveConfig({
        ttsProfiles: {
          ai: {
            gptWeightsPath: nodes.aiGptModelSelect.value,
            sovitsWeightsPath: nodes.aiSovitsModelSelect.value,
          },
        },
      });
      log("雪风 TTS 模型已保存，下次 AI 合成时自动切换。");
    } catch (error) {
      reportError(error, "保存雪风 TTS 模型失败");
    }
  });

  nodes.importGptButton.addEventListener("click", () =>
    nodes.gptFileInput.click(),
  );
  nodes.importSovitsButton.addEventListener("click", () =>
    nodes.sovitsFileInput.click(),
  );
  nodes.importReferenceButton.addEventListener("click", () =>
    nodes.referenceFileInput.click(),
  );
  nodes.gptFileInput.addEventListener("change", () =>
    importFile("gpt", nodes.gptFileInput, nodes.gptModelSelect),
  );
  nodes.sovitsFileInput.addEventListener("change", () =>
    importFile("sovits", nodes.sovitsFileInput, nodes.sovitsModelSelect),
  );
  nodes.referenceFileInput.addEventListener("change", () =>
    importFile("reference", nodes.referenceFileInput),
  );

  nodes.useReferenceButton.addEventListener("click", async () => {
    setStatus("正在应用参考音频");
    try {
      await audioEditor.applyCurrentReference();
      await loadResources();
      log("参考音频和参考文本已保存。");
    } catch (error) {
      reportError(error, "应用参考音频失败");
    } finally {
      setStatus("等待输入");
    }
  });
  nodes.trimReferenceButton.addEventListener("click", async () => {
    setStatus("正在裁剪参考音频");
    try {
      await audioEditor.trimAndApply();
      log("选区已裁剪为新文件并设为当前参考音频。");
    } catch (error) {
      reportError(error, "裁剪失败");
    } finally {
      setStatus("等待输入");
    }
  });
  nodes.auxReferenceSelect.addEventListener(
    "change",
    updateAuxiliaryStatus,
  );
  nodes.saveAuxReferencesButton.addEventListener("click", async () => {
    try {
      await saveConfig({
        tts: { auxRefAudioPaths: selectedAuxiliaryPaths() },
      });
      renderAuxiliaryReferences();
      log("辅助参考音频已保存，将通过 GPT-SoVITS 官方接口参与音色融合。");
    } catch (error) {
      reportError(error, "保存辅助参考音频失败");
    }
  });
  nodes.clearAuxReferencesButton.addEventListener("click", () => {
    for (const option of nodes.auxReferenceSelect.options) {
      option.selected = false;
    }
    updateAuxiliaryStatus();
  });

  nodes.configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveConfig(readForm(nodes.configForm));
      log("显示与发送设置已保存。");
    } catch (error) {
      reportError(error, "保存显示设置失败");
    }
  });
  nodes.ttsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveConfig(readForm(nodes.ttsForm));
      log("TTS 推理设置已保存。");
    } catch (error) {
      reportError(error, "保存 TTS 设置失败");
    }
  });
  for (const input of document.querySelectorAll("input[data-output]")) {
    input.addEventListener("input", () => syncSliderOutputs(nodes.ttsForm));
  }
  nodes.refreshFontsButton.addEventListener("click", async () => {
    try {
      await loadFonts();
    } catch (error) {
      reportError(error, "刷新字体失败");
    }
  });
}

async function pollStatus() {
  try {
    const data = await api("/api/status");
    updateTtsStatus(data.tts);
    const ttsText = data.tts.ok
      ? "TTS 已连接"
      : `TTS 未连接：${data.tts.message}`;
    const browserText = data.browser.connected
      ? "网页发送器已连接"
      : "网页发送器未打开";
    const summary = `${ttsText}；${browserText}`;
    if (summary !== state.lastStatusSummary) {
      state.lastStatusSummary = summary;
      log(summary);
    }
  } catch (error) {
    reportError(error, "状态检查失败");
  }
}

async function initialize() {
  bindEvents();
  await loadConfig();
  await loadResources();
  await Promise.all([
    loadFonts(),
    loadAudioDevices().catch((error) => {
      nodes.audioOutputStatus.textContent = error.message;
      log(`读取音频设备失败：${error.message}`);
    }),
  ]);
  audioEditor = new ReferenceAudioEditor({
    api,
    log,
    getConfig: () => state.config,
    saveConfig,
    refreshResources: refreshAfterReferenceChange,
  });
  audioEditor.setResources(state.resources.references);
  await audioEditor.loadSelected();
  setStatus("等待输入");
  await pollStatus();
  await refreshAiStatus();
  await refreshAiContext();
  await refreshAiScene();
  await refreshMusicCollaboration();
  audioPlaybackController.start();
  setInterval(pollStatus, 10000);
  setInterval(refreshAiStatus, 3000);
  setInterval(refreshAiContext, 3000);
  setInterval(refreshAiScene, 3000);
  restartMusicPolling();
  nodes.lineInput.focus();
}

initialize().catch((error) => reportError(error, "初始化失败"));
