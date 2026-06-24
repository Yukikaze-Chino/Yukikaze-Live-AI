const ALLOWED_QUEUE_ACTIONS = new Set([
  "delete",
  "top",
  "play_now",
  "skip_current",
]);

const ACTIONS_WITH_INDEX = new Set(["delete", "top", "play_now"]);

export function validateBiliNcmBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("请输入本机 BiliNCM 地址。");
  }
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    !allowedHosts.has(url.hostname) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("请输入本机 BiliNCM 地址。");
  }
  return url.origin;
}

export function normalizeBiliNcmState(payload = {}) {
  const current = payload?.current || {};
  return {
    connected: true,
    stale: false,
    error: "",
    status: String(payload?.status || ""),
    accepting: Boolean(payload?.accepting),
    playing: Boolean(payload?.playing),
    cdpConnected: Boolean(payload?.cdpConnected),
    current: normalizeSong(current),
    queue: Array.isArray(payload?.queue)
      ? payload.queue.slice(0, 50).map(normalizeQueueItem)
      : [],
    rejects: Array.isArray(payload?.rejects)
      ? payload.rejects.slice(0, 5).map(normalizeReject)
      : [],
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeBiliNcmLogs(payload = []) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => ({
      time: String(entry?.Time || "").trim(),
      color: String(entry?.Color || "Gray").trim() || "Gray",
      message: String(entry?.Message || "").trim(),
    }))
    .filter((entry) => entry.message)
    .slice(-100);
}

export class MusicCollaborator {
  constructor({ fetchImpl = fetch, timeoutMs = 3000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async refresh(baseUrl) {
    const normalizedBaseUrl = validateBiliNcmBaseUrl(baseUrl);
    try {
      const payload = await this.request(normalizedBaseUrl, "/data");
      let logs = [];
      let logsAvailable = false;
      try {
        logs = normalizeBiliNcmLogs(
          await this.request(normalizedBaseUrl, "/api/logs"),
        );
        logsAvailable = true;
      } catch {
        // Older BiliNCM versions can expose the state API without raw logs.
      }
      return { ...normalizeBiliNcmState(payload), logs, logsAvailable };
    } catch (error) {
      return disconnectedMusicState(error);
    }
  }

  async queueAction(baseUrl, { action, index } = {}) {
    if (!ALLOWED_QUEUE_ACTIONS.has(action)) {
      throw new Error("不支持的点歌队列操作。");
    }
    if (ACTIONS_WITH_INDEX.has(action) && (!Number.isInteger(index) || index < 0)) {
      throw new Error("该点歌队列操作需要有效的序号。");
    }
    const body = {
      action,
      ...(ACTIONS_WITH_INDEX.has(action) ? { index } : {}),
    };
    return this.request(validateBiliNcmBaseUrl(baseUrl), "/api/queue/action", {
      method: "POST",
      body,
    });
  }

  async toggleAccepting(baseUrl) {
    return this.request(validateBiliNcmBaseUrl(baseUrl), "/api/state/toggle", {
      method: "POST",
      body: {},
    });
  }

  async togglePlayback(baseUrl) {
    return this.request(
      validateBiliNcmBaseUrl(baseUrl),
      "/api/state/toggle_play",
      { method: "POST", body: {} },
    );
  }

  async request(baseUrl, pathname, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${baseUrl}${pathname}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new Error(`BiliNCM HTTP ${response?.status || "请求失败"}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

function disconnectedMusicState(error) {
  return {
    connected: false,
    stale: false,
    error: error instanceof Error ? error.message : String(error || "BiliNCM 未连接。"),
    status: "",
    accepting: false,
    playing: false,
    cdpConnected: false,
    current: normalizeSong(),
    queue: [],
    rejects: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSong(value = {}) {
  return {
    id: String(value?.Id || ""),
    title: String(value?.SongName || ""),
    artist: String(value?.ArtistName || ""),
    requester: String(value?.OrderedBy || ""),
  };
}

function normalizeQueueItem(value = {}, index) {
  return {
    index,
    ...normalizeSong(value),
    requesterAvatar: String(value?.OrderedByAvatar || ""),
    guardLevel: Number(value?.GuardLevel || 0),
  };
}

function normalizeReject(value = {}) {
  return {
    id: String(value?.id || ""),
    requester: String(value?.user?.uname || value?.user?.name || ""),
    reason: String(value?.reason || ""),
  };
}
