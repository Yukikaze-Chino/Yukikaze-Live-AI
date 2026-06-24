import { DEFAULT_CONFIG } from "./core.mjs";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1
    ? Math.trunc(number)
    : fallback;
}

export function visibleContextLimit(config) {
  return finiteInteger(config?.ai?.contextLimit, DEFAULT_CONFIG.ai.contextLimit);
}

export function localHistoryLimit(config) {
  return finiteInteger(
    config?.ai?.localHistoryLimit,
    DEFAULT_CONFIG.ai.localHistoryLimit,
  );
}

export function contextReadLimit(config) {
  return Math.max(visibleContextLimit(config), localHistoryLimit(config));
}

export function filterConversationEventsForAi(config, events) {
  const enabledKinds = config?.ai?.contextEventKinds || {};
  const filtered = (Array.isArray(events) ? events : []).filter((event) => {
    const kind = String(event?.kind || "");
    return enabledKinds[kind] !== false;
  });
  return filtered.slice(-visibleContextLimit(config));
}

export function readVisibleAiContext({ config, memory, now = new Date() }) {
  const events = memory.getRecentConversationEvents({
    limit: contextReadLimit(config),
  });
  return attachEventTimeContext(
    filterConversationEventsForAi(config, events),
    { now },
  );
}

export function buildCurrentTimeContext({
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = localDateTimeParts(date, timeZone);
  return {
    iso: date.toISOString(),
    timeZone,
    localDateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: new Intl.DateTimeFormat("zh-CN", {
      weekday: "long",
      timeZone,
    }).format(date),
    dayPart: dayPartForHour(Number(parts.hour)),
  };
}

export function attachEventTimeContext(
  events,
  { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {},
) {
  const current = now instanceof Date ? now : new Date(now);
  return (Array.isArray(events) ? events : []).map((event) => {
    const timestamp = event?.createdAt || event?.receivedAt || "";
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return { ...event, localTime: "", ageSeconds: null, ageLabel: "" };
    }
    const ageSeconds = Math.max(
      0,
      Math.floor((current.getTime() - date.getTime()) / 1000),
    );
    return {
      ...event,
      localTime: formatLocalTime(date, timeZone),
      ageSeconds,
      ageLabel: formatAgeLabel(ageSeconds),
    };
  });
}

function localDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatLocalTime(date, timeZone) {
  const parts = localDateTimeParts(date, timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function dayPartForHour(hour) {
  if (hour < 5) return "凌晨";
  if (hour < 9) return "早上";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

function formatAgeLabel(seconds) {
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  return `${Math.floor(seconds / 86400)}天前`;
}
