import crypto from "node:crypto";
import zlib from "node:zlib";

const HEADER_SIZE = 16;
const MAX_UNKNOWN_COMMANDS = 20;
const MAX_RECENT_COMMANDS = 50;

const INTERACT_WORD_TYPES = Object.freeze({
  1: {
    kind: "room_enter",
    text: (name) => `${name} 进入了直播间`,
    actionable: true,
  },
  2: {
    kind: "follow",
    text: (name) => `${name} 关注了直播间`,
    actionable: true,
  },
  3: {
    kind: "share",
    text: (name) => `${name} 分享了直播间`,
    actionable: false,
  },
});

export function buildBiliPacket({ operation, protocolVersion = 0, body }) {
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(String(body || ""), "utf8");
  const buffer = Buffer.alloc(HEADER_SIZE + payload.length);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.writeUInt16BE(HEADER_SIZE, 4);
  buffer.writeUInt16BE(protocolVersion, 6);
  buffer.writeUInt32BE(operation, 8);
  buffer.writeUInt32BE(1, 12);
  payload.copy(buffer, HEADER_SIZE);
  return buffer;
}

export function decodeBiliPackets(data) {
  const buffer = Buffer.from(data);
  const packets = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const protocolVersion = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);

    if (
      packetLength < HEADER_SIZE ||
      headerLength < HEADER_SIZE ||
      offset + packetLength > buffer.length
    ) {
      break;
    }

    const body = buffer.subarray(offset + headerLength, offset + packetLength);
    if (protocolVersion === 2) {
      packets.push(...decodeBiliPackets(zlib.inflateSync(body)));
    } else if (protocolVersion === 3) {
      packets.push(...decodeBiliPackets(zlib.brotliDecompressSync(body)));
    } else {
      packets.push({
        operation,
        protocolVersion,
        body: parsePacketBody(body),
      });
    }
    offset += packetLength;
  }

  return packets;
}

export function normalizeBiliDanmaku(event, { roomId }) {
  const liveEvent = normalizeBiliLiveEvent(event, { roomId });
  return liveEvent?.kind === "danmaku" ? liveEvent : null;
}

export function normalizeBiliLiveEvent(event, { roomId }) {
  const command = normalizeCommand(event?.cmd);
  if (!command) {
    return null;
  }
  if (command === "DANMU_MSG") {
    return normalizeDanmakuEvent(event, { roomId });
  }
  if (command === "INTERACT_WORD" || command === "INTERACT_WORD_V2") {
    return normalizeInteractWordEvent(event, { roomId });
  }
  if (command === "ENTRY_EFFECT") {
    return normalizeEntryEffectEvent(event, { roomId });
  }
  if (command === "SEND_GIFT") {
    return normalizeGiftEvent(event, { roomId });
  }
  if (command === "ONLINE_RANK_V2" || command === "ONLINE_RANK_V3") {
    return normalizeOnlineRankEvent(event, { roomId });
  }
  if (command === "GUARD_BUY") {
    return normalizeGuardEvent(event, { roomId });
  }
  if (command === "SUPER_CHAT_MESSAGE") {
    return normalizeSuperChatEvent(event, { roomId });
  }
  if (command === "LIKE_INFO_V3_CLICK") {
    return normalizeLikeEvent(event, { roomId });
  }
  return null;
}

function normalizeDanmakuEvent(event, { roomId }) {
  if (!String(event?.cmd || "").startsWith("DANMU_MSG")) {
    return null;
  }

  const text = String(event.info?.[1] || "").trim();
  const userId = String(event.info?.[2]?.[0] || "");
  const userName = String(event.info?.[2]?.[1] || "");
  if (!text || !userId) {
    return null;
  }

  const receivedAt = new Date().toISOString();
  const providerId =
    event.info?.[0]?.[7] ||
    event.info?.[0]?.[5] ||
    `${roomId}:${userId}:${text}:${receivedAt}`;

  return {
    id: crypto
      .createHash("sha1")
      .update(String(providerId))
      .digest("hex"),
    roomId: String(roomId),
    kind: "danmaku",
    userId,
    userName,
    text,
    receivedAt,
    source: "bilibili",
    status: "unclaimed",
    actionable: true,
  };
}

function normalizeInteractWordEvent(event, { roomId }) {
  const data = event?.data || {};
  const decoded = decodeInteractWordPb(data.pb);
  const payload = decoded ? { ...data, ...decoded } : data;
  const userId = liveUserId(payload);
  const userName = liveUserName(payload);
  const type = Number(
    payload.msg_type ?? payload.msgType ?? payload.msg_type_v2 ?? payload.type,
  );
  const definition = INTERACT_WORD_TYPES[type];
  if (!definition || !userId || !userName) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: definition.kind,
    userId,
    userName,
    text: definition.text(userName),
    receivedAt: timestampToIso(payload.timestamp ?? payload.ts),
    providerId:
      payload.trigger_time ||
      payload.timestamp ||
      `${event.cmd}:${roomId}:${userId}:${type}:${Date.now()}`,
    actionable: definition.actionable,
  });
}

function normalizeEntryEffectEvent(event, { roomId }) {
  const data = event?.data || {};
  const userId = liveUserId(data);
  const userName = liveUserName(data) || parseEntryEffectName(data);
  if (!userId || !userName) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "room_enter",
    userId,
    userName,
    text: INTERACT_WORD_TYPES[1].text(userName),
    receivedAt: timestampToIso(data.trigger_time ?? data.timestamp ?? data.ts),
    providerId:
      data.id ||
      data.trigger_time ||
      data.timestamp ||
      `${event.cmd}:${roomId}:${userId}:${Date.now()}`,
    actionable: true,
  });
}

function normalizeGiftEvent(event, { roomId }) {
  const data = event?.data || {};
  const userId = liveUserId(data);
  const userName = liveUserName(data);
  const giftName = stringValue(data.giftName ?? data.gift_name ?? data.gift_name_mini);
  const count = Math.max(1, Number(data.num ?? data.gift_num ?? 1) || 1);
  if (!userId || !userName || !giftName) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "gift",
    userId,
    userName,
    text: `${userName} 送出了 ${giftName} x${count}`,
    receivedAt: timestampToIso(data.timestamp ?? data.ts),
    providerId:
      data.tid ||
      data.msg_id ||
      `${event.cmd}:${roomId}:${userId}:${giftName}:${count}:${data.timestamp || Date.now()}`,
    actionable: true,
  });
}

function normalizeOnlineRankEvent(event, { roomId }) {
  const list = Array.isArray(event?.data?.list) ? event.data.list : [];
  const names = list
    .map((item) => stringValue(item.uname ?? item.name ?? item.username))
    .filter(Boolean)
    .slice(0, 10);
  if (!names.length) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "online_snapshot",
    userId: "",
    userName: "",
    text: `在线榜参考：${names.join("、")}`,
    receivedAt: new Date().toISOString(),
    providerId: `${event.cmd}:${roomId}:${names.join("|")}`,
    actionable: false,
  });
}

function normalizeGuardEvent(event, { roomId }) {
  const data = event?.data || {};
  const userId = stringValue(data.uid);
  const userName = stringValue(data.username ?? data.uname);
  const levelName = stringValue(data.gift_name ?? data.guard_level_name) || "舰长";
  const count = Math.max(1, Number(data.num ?? 1) || 1);
  if (!userId || !userName) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "guard",
    userId,
    userName,
    text: `${userName} 开通了 ${levelName} x${count}`,
    receivedAt: timestampToIso(data.start_time ?? data.timestamp),
    providerId:
      data.id ||
      `${event.cmd}:${roomId}:${userId}:${levelName}:${count}:${data.start_time || Date.now()}`,
    actionable: true,
  });
}

function normalizeSuperChatEvent(event, { roomId }) {
  const data = event?.data || {};
  const userInfo = data.user_info || {};
  const userId = stringValue(data.uid ?? userInfo.uid);
  const userName = stringValue(data.uname ?? userInfo.uname);
  const message = stringValue(data.message ?? data.message_trans);
  if (!userId || !userName || !message) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "super_chat",
    userId,
    userName,
    text: `${userName} 发送了醒目留言：${message}`,
    receivedAt: timestampToIso(data.start_time ?? data.ts),
    providerId:
      data.id ||
      `${event.cmd}:${roomId}:${userId}:${message}:${data.start_time || Date.now()}`,
    actionable: true,
  });
}

function normalizeLikeEvent(event, { roomId }) {
  const data = event?.data || {};
  const userId = liveUserId(data);
  const userName = liveUserName(data);
  if (!userId || !userName) {
    return null;
  }
  return createLiveEvent({
    roomId,
    kind: "like",
    userId,
    userName,
    text: `${userName} 点赞了直播间`,
    receivedAt: timestampToIso(data.timestamp ?? data.ts),
    providerId:
      data.timestamp ||
      `${event.cmd}:${roomId}:${userId}:${data.count || ""}:${Date.now()}`,
    actionable: false,
  });
}

function createLiveEvent({
  roomId,
  kind,
  userId,
  userName,
  text,
  receivedAt,
  providerId,
  actionable,
}) {
  return {
    id: crypto
      .createHash("sha1")
      .update(String(providerId))
      .digest("hex"),
    roomId: String(roomId),
    kind,
    userId: stringValue(userId),
    userName: stringValue(userName),
    text: String(text || "").trim(),
    receivedAt,
    source: "bilibili",
    status: "unclaimed",
    actionable: Boolean(actionable),
  };
}

function normalizeCommand(command) {
  return String(command || "").split(":")[0].trim();
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function liveUserId(data = {}) {
  return stringValue(
    data.uid ??
      data.user_id ??
      data.target_id ??
      data.uinfo?.uid ??
      data.uinfo?.base?.uid,
  );
}

function liveUserName(data = {}) {
  return stringValue(
    data.uname ??
      data.username ??
      data.user_name ??
      data.name ??
      data.uinfo?.uname ??
      data.uinfo?.base?.name,
  );
}

function parseEntryEffectName(data = {}) {
  const copy = stringValue(data.copy_writing ?? data.copy_writing_v2);
  const match = copy.match(/(?:欢迎|欢送)?\s*([^\s，,：:]+)\s*(?:进入|来到)/);
  return match ? match[1] : "";
}

function timestampToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return new Date().toISOString();
  }
  const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function decodeInteractWordPb(value) {
  const encoded = stringValue(value);
  if (!encoded) return null;
  let buffer;
  try {
    buffer = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  if (!buffer.length) return null;

  const parsed = {};
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const tag = readProtoVarint(buffer, offset);
      offset = tag.offset;
      const field = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 7n);

      if (wireType === 0) {
        const result = readProtoVarint(buffer, offset);
        offset = result.offset;
        const value = Number(result.value);
        if (field === 1) parsed.uid = value;
        if (field === 5) parsed.msg_type = value;
        if (field === 7) parsed.timestamp = value;
        if (field === 16) parsed.privilege_type = value;
      } else if (wireType === 2) {
        const length = readProtoVarint(buffer, offset);
        offset = length.offset;
        const end = offset + Number(length.value);
        if (end > buffer.length) break;
        const bytes = buffer.subarray(offset, end);
        offset = end;
        if (field === 2) {
          parsed.uname = bytes.toString("utf8").trim();
        }
      } else if (wireType === 1) {
        offset += 8;
      } else if (wireType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
  } catch {
    return null;
  }

  return Object.keys(parsed).length ? parsed : null;
}

function readProtoVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  while (index < buffer.length) {
    const byte = BigInt(buffer[index]);
    value |= (byte & 0x7fn) << shift;
    index += 1;
    if ((byte & 0x80n) === 0n) {
      return { value, offset: index };
    }
    shift += 7n;
  }
  throw new Error("unterminated protobuf varint");
}

export class BiliReceiver extends EventTarget {
  constructor({
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    heartbeatSeconds = 30,
    pageProvider = null,
    pagePollMilliseconds = 2000,
  } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatSeconds = heartbeatSeconds;
    this.pageProvider = pageProvider;
    this.pagePollMilliseconds = pagePollMilliseconds;
    this.socket = null;
    this.heartbeat = null;
    this.page = null;
    this.pagePoll = null;
    this.pagePollRunning = false;
    this.pageMirrorSeeded = false;
    this.seenPageEventKeys = new Set();
    this.ignoredPageMessages = [];
    this.roomId = "";
    this.realRoomId = "";
    this.status = {
      connected: false,
      lastError: "",
      reconnects: 0,
      lastEvent: null,
      unknownCommands: [],
      recentCommands: [],
      commandCounts: {},
      eventCounts: {},
      browserMirror: {
        enabled: Boolean(pageProvider),
        connected: false,
        lastError: "",
      },
    };
  }

  async start({ roomId }) {
    this.stop();
    this.roomId = String(roomId);
    const { realRoomId, host, token } = await this.resolveDanmakuServer(
      this.roomId,
    );
    this.realRoomId = realRoomId;
    this.socket = new this.WebSocketImpl(`wss://${host}/sub`);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      this.status.connected = true;
      this.status.lastError = "";
      this.socket.send(
        buildBiliPacket({
          operation: 7,
          body: JSON.stringify({
            uid: 0,
            roomid: Number(realRoomId),
            protover: 3,
            platform: "web",
            type: 2,
            key: token,
          }),
        }),
      );
      this.heartbeat = setInterval(() => {
        this.socket?.send(buildBiliPacket({ operation: 2, body: "{}" }));
      }, this.heartbeatSeconds * 1000);
    };
    this.socket.onmessage = (event) => {
      for (const packet of decodeBiliPackets(event.data)) {
        const liveEvent = normalizeBiliLiveEvent(packet.body, {
          roomId: this.roomId,
        });
        this.recordCommandDiagnostic(packet.body, liveEvent);
        if (liveEvent) {
          if (liveEvent.kind === "danmaku") {
            this.ignorePageDanmaku(liveEvent);
          }
          this.status.lastEvent = {
            kind: liveEvent.kind,
            text: liveEvent.text,
            actionable: liveEvent.actionable,
            receivedAt: liveEvent.receivedAt,
          };
          this.dispatchEvent(
            new CustomEvent("live-event", { detail: liveEvent }),
          );
          if (liveEvent.kind === "danmaku") {
            this.dispatchEvent(
              new CustomEvent("danmaku", { detail: liveEvent }),
            );
          }
        } else {
          this.recordUnknownCommand(packet.body);
        }
      }
    };
    this.socket.onerror = () => {
      this.status.lastError = "Bilibili danmaku connection error";
    };
    this.socket.onclose = () => {
      this.status.connected = false;
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    };
    if (this.pageProvider) {
      this.startPageMirror({ roomId: this.roomId }).catch((error) => {
        this.status.browserMirror.lastError = error.message;
      });
    }
  }

  async resolveDanmakuServer(roomId) {
    const init = await this.fetchImpl(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
    ).then((response) => response.json());
    const realRoomId = String(init.data?.room_id || roomId);
    const info = await this.fetchImpl(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${encodeURIComponent(realRoomId)}&type=0`,
    ).then((response) => response.json());
    const server = this.extractDanmakuServer(info);
    if (server.token && server.host) {
      return { realRoomId, ...server };
    }

    const legacy = await this.fetchImpl(
      `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${encodeURIComponent(realRoomId)}&platform=pc&player=web`,
    ).then((response) => response.json());
    const fallback = this.extractDanmakuServer(legacy);
    const host = fallback.host || server.host || "broadcastlv.chat.bilibili.com";
    const token = fallback.token || server.token || "";
    return { realRoomId, host, token };
  }

  extractDanmakuServer(payload) {
    const data = payload?.data || {};
    const host =
      data.host_list?.[0]?.host ||
      data.host_server_list?.[0]?.host ||
      data.server_list?.[0]?.host ||
      data.host ||
      "";
    return {
      host,
      token: data.token || "",
    };
  }

  stop() {
    clearInterval(this.heartbeat);
    clearInterval(this.pagePoll);
    this.heartbeat = null;
    this.pagePoll = null;
    this.pagePollRunning = false;
    this.socket?.close();
    this.socket = null;
    this.status.connected = false;
    this.status.browserMirror.connected = false;
  }

  currentStatus() {
    return {
      ...this.status,
      unknownCommands: [...this.status.unknownCommands],
      recentCommands: [...this.status.recentCommands],
      commandCounts: { ...this.status.commandCounts },
      eventCounts: { ...this.status.eventCounts },
      browserMirror: { ...this.status.browserMirror },
    };
  }

  recordCommandDiagnostic(body, liveEvent) {
    const command = normalizeCommand(body?.cmd);
    if (!command) {
      return;
    }
    const recognized = Boolean(liveEvent);
    const receivedAt = liveEvent?.receivedAt || new Date().toISOString();
    this.status.commandCounts[command] =
      (this.status.commandCounts[command] || 0) + 1;
    if (liveEvent?.kind) {
      this.status.eventCounts[liveEvent.kind] =
        (this.status.eventCounts[liveEvent.kind] || 0) + 1;
    }
    this.status.recentCommands = [
      {
        cmd: command,
        recognized,
        kind: liveEvent?.kind || "",
        actionable: Boolean(liveEvent?.actionable),
        text: liveEvent?.text || "",
        receivedAt,
        dataKeys: commandDataKeys(body),
      },
      ...this.status.recentCommands,
    ].slice(0, MAX_RECENT_COMMANDS);
  }

  recordUnknownCommand(body) {
    const command = normalizeCommand(body?.cmd);
    if (!command) {
      return;
    }
    this.status.unknownCommands = [
      {
        cmd: command,
        receivedAt: new Date().toISOString(),
      },
      ...this.status.unknownCommands.filter((item) => item.cmd !== command),
    ].slice(0, MAX_UNKNOWN_COMMANDS);
  }

  ignorePageDanmakuText(text) {
    this.ignorePageDanmaku({ text });
  }

  ignorePageDanmaku({ userName = "", text }) {
    const value = String(text || "").trim();
    if (!value) return;
    this.ignoredPageMessages.push({
      userName: stringValue(userName),
      text: value,
    });
    this.ignoredPageMessages = this.ignoredPageMessages.slice(-50);
  }

  async startPageMirror({ roomId }) {
    if (!this.pageProvider) return;
    this.roomId = String(roomId || this.roomId);
    this.page = await this.pageProvider();
    this.status.browserMirror.connected = true;
    this.status.browserMirror.lastError = "";
    await this.seedPageChat();
    clearInterval(this.pagePoll);
    this.pagePoll = setInterval(() => {
      this.pollPageChat().catch((error) => {
        this.status.browserMirror.lastError = error.message;
      });
    }, this.pagePollMilliseconds);
    this.pagePoll.unref?.();
  }

  async seedPageChat() {
    const items = await this.readPageChatItems();
    if (!items.length) return false;
    for (const item of items) {
      this.seenPageEventKeys.add(pageChatKey(item));
    }
    this.pageMirrorSeeded = true;
    return true;
  }

  async pollPageChat() {
    if (!this.page || this.pagePollRunning) return;
    this.pagePollRunning = true;
    try {
      if (!this.pageMirrorSeeded) {
        await this.seedPageChat();
        return;
      }
      const items = await this.readPageChatItems();
      for (const item of items) {
        const key = pageChatKey(item);
        if (this.seenPageEventKeys.has(key)) continue;
        this.seenPageEventKeys.add(key);
        const event = normalizeBiliPageDanmaku(item, {
          roomId: this.roomId,
        });
        if (
          !event ||
          this.consumeIgnoredPageText(event.text, event.userName)
        ) continue;
        this.recordLastEvent(event);
        this.dispatchEvent(new CustomEvent("live-event", { detail: event }));
        this.dispatchEvent(new CustomEvent("danmaku", { detail: event }));
      }
    } finally {
      this.pagePollRunning = false;
    }
  }

  async readPageChatItems() {
    if (!this.page) return [];
    return await this.page.evaluate(extractPageChatItemsFromDocument);
  }

  consumeIgnoredPageText(text, userName = "") {
    const value = String(text || "").trim();
    const name = stringValue(userName);
    const index = this.ignoredPageMessages.findIndex(
      (item) =>
        item.text === value &&
        (!item.userName || !name || item.userName === name),
    );
    if (index === -1) return false;
    this.ignoredPageMessages.splice(index, 1);
    return true;
  }

  recordLastEvent(event) {
    this.status.lastEvent = {
      kind: event.kind,
      text: event.text,
      actionable: event.actionable,
      receivedAt: event.receivedAt,
    };
  }
}

function commandDataKeys(body) {
  const data = body && typeof body === "object" ? body.data : null;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }
  return Object.keys(data).sort().slice(0, 30);
}

function parsePacketBody(body) {
  const text = body.toString("utf8").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function normalizeBiliPageDanmaku(item, { roomId }) {
  const userName = stringValue(item?.userName);
  const text = stringValue(item?.text);
  if (!userName || !text) return null;
  const receivedAt = new Date().toISOString();
  return {
    id: crypto
      .createHash("sha1")
      .update(`page:${roomId}:${pageChatKey(item)}`)
      .digest("hex"),
    roomId: String(roomId),
    kind: "danmaku",
    userId: "",
    userName,
    text,
    receivedAt,
    source: "bilibili-page",
    status: "unclaimed",
    actionable: true,
  };
}

function pageChatKey(item) {
  return [
    Number.isFinite(Number(item?.index)) ? Number(item.index) : 0,
    stringValue(item?.userName),
    stringValue(item?.text),
  ].join("|");
}

export function extractPageChatItemsFromDocument(root = document) {
  const candidateSelectors = [
    "#chat-items .chat-item.danmaku-item",
    "#chat-items .chat-item",
    "#chat-items [class*='danmaku-item']",
    "#chat-items [class*='chat-item']",
    "[class*='chat-list'] [class*='chat-item']",
    "[class*='chat-item'][data-danmaku]",
  ];
  const nameSelectors = [
    ".user-name",
    ".danmaku-item-left",
    "[class*='user-name']",
    "[class*='username']",
    "[class*='nickname']",
    "[class*='nick-name']",
  ];
  const textSelectors = [
    ".danmaku-item-right",
    "[class*='danmaku-content']",
    "[class*='danmaku-text']",
    "[class*='chat-content']",
    "[class*='message-content']",
    "[class*='message-text']",
    "[class*='content']",
  ];
  const skippedPrefixes = [
    "系统提示",
    "直播小助手",
    "欢迎来到",
  ];
  const fallbackViewerName = "网页观众";

  const clean = (value) =>
    String(value || "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const compactName = (value) =>
    clean(value)
      .replace(/[：:]\s*$/, "")
      .replace(/^主播\s*/, "")
      .trim();
  const queryText = (element, selectors) => {
    for (const selector of selectors) {
      const value = clean(element.querySelector?.(selector)?.textContent);
      if (value) return value;
    }
    return "";
  };
  const parseFallback = ({ rawText, userName, text }) => {
    let nextName = compactName(userName);
    let nextText = clean(text);
    const raw = clean(rawText);
    if (!raw) return null;
    if (skippedPrefixes.some((prefix) => raw.startsWith(prefix))) {
      return null;
    }

    if (!nextText) {
      const colonMatch = raw.match(/^(.{1,40}?)[：:]\s*(.+)$/);
      if (colonMatch) {
        nextName ||= compactName(colonMatch[1]);
        nextText = clean(colonMatch[2]);
      }
    }

    if (!nextText && nextName && raw.includes(nextName)) {
      const afterName = raw.slice(raw.lastIndexOf(nextName) + nextName.length);
      nextText = clean(afterName.replace(/^[·\-:：\s]+/, ""));
    }

    if (!nextText) {
      const dotMatch = raw.match(/^(.{1,48}?)[·•]\s*(.+)$/);
      if (dotMatch) {
        nextName ||= compactName(dotMatch[1]);
        nextText = clean(dotMatch[2]);
      }
    }

    if (!nextText) {
      const lines = String(rawText || "")
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);
      if (lines.length >= 2) {
        nextName ||= compactName(lines[0]);
        nextText = clean(lines.at(-1));
      }
    }

    if (!nextText) {
      nextText = raw;
    }
    if (!nextName) {
      nextName = fallbackViewerName;
    }
    if (!nextText || skippedPrefixes.some((prefix) => nextText.startsWith(prefix))) {
      return null;
    }
    return { userName: nextName, text: nextText };
  };
  const isNameOnlyRow = (row) => {
    const userName = compactName(row?.userName);
    const text = clean(row?.text).replace(/[：:]\s*$/, "");
    return Boolean(userName && text === userName);
  };

  const candidates = [];
  const seenElements = new Set();
  for (const selector of candidateSelectors) {
    for (const item of Array.from(root.querySelectorAll?.(selector) || [])) {
      if (seenElements.has(item)) continue;
      seenElements.add(item);
      candidates.push(item);
    }
  }
  const candidateSet = new Set(candidates);
  const elements = candidates.filter((item) => {
    for (
      let ancestor = item.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (candidateSet.has(ancestor)) return false;
    }
    return true;
  });

  const rows = [];
  const seenRows = new Set();
  let pendingUserName = "";
  for (const item of elements.slice(-120)) {
    const rawText = clean(item.innerText || item.textContent);
    const parsed = parseFallback({
      rawText,
      userName: queryText(item, nameSelectors),
      text: queryText(item, textSelectors),
    });
    if (!parsed) continue;
    if (isNameOnlyRow(parsed)) {
      pendingUserName = parsed.userName;
      continue;
    }
    if (pendingUserName && parsed.userName === fallbackViewerName) {
      parsed.userName = pendingUserName;
      pendingUserName = "";
    } else if (parsed.userName !== fallbackViewerName) {
      pendingUserName = "";
    }
    const rowKey = `${parsed.userName}|${parsed.text}`;
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);
    rows.push({
      index: rows.length,
      userName: parsed.userName,
      text: parsed.text,
    });
  }

  return rows.slice(-80);
}
