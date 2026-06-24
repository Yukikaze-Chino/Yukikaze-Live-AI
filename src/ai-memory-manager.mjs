const MEMORY_TYPES = new Set([
  "viewer_memory",
  "stream_memory",
  "style_memory",
  "topic_memory",
  "fact_memory",
]);

function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeType(value) {
  const type = normalizeText(value);
  return MEMORY_TYPES.has(type) ? type : "fact_memory";
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const content = normalizeText(candidate.content);
  if (!content) {
    return null;
  }
  return {
    type: normalizeType(candidate.type),
    content,
    sourceEventIds: Array.isArray(candidate.sourceEventIds)
      ? candidate.sourceEventIds.map(String)
      : [],
    importance: Math.trunc(clampNumber(candidate.importance, 1, 1, 5)),
    confidence: clampNumber(candidate.confidence, 0.5, 0, 1),
    reason: normalizeText(candidate.reason),
    rememberLongTerm: Boolean(
      candidate.rememberLongTerm ?? candidate.remember_long_term,
    ),
  };
}

export function buildMemorySummaryMessages({
  persona = "",
  shortTermSummary = "",
  recentEvents = [],
  longTermMemories = [],
} = {}) {
  return [
    {
      role: "system",
      content: [
        "你是雪风直播桥接工具的记忆总结器。",
        "目标不是简单压缩上下文，而是更新当前直播情景、发现重复强化的信息，并判断候选长期记忆。",
        "闀挎湡璁板繂: only save repeated or clearly important information.",
        "长期记忆只保存反复出现或明确重要的信息，不保存一次性闲聊、强时效事实、低可信事实和未经主动表达的隐私。",
        "输出 JSON：shortTermSummary, memoryCandidates, styleAdjustments。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          persona,
          shortTermSummary,
          recentEvents,
          longTermMemories,
        },
        null,
        2,
      ),
    },
  ];
}

export function parseMemorySummaryResult(text) {
  const parsed = parseJson(text, {});
  return {
    shortTermSummary: normalizeText(parsed.shortTermSummary),
    memoryCandidates: Array.isArray(parsed.memoryCandidates)
      ? parsed.memoryCandidates.map(normalizeCandidate).filter(Boolean)
      : [],
    styleAdjustments: Array.isArray(parsed.styleAdjustments)
      ? parsed.styleAdjustments.map(normalizeText).filter(Boolean)
      : [],
  };
}

export function applyMemorySummaryResult(store, result) {
  const normalized =
    typeof result === "string" ? parseMemorySummaryResult(result) : result || {};
  if (normalizeText(normalized.shortTermSummary)) {
    store.setStreamSummary(normalized.shortTermSummary, { source: "auto" });
  }

  const applied = [];
  for (const candidate of Array.isArray(normalized.memoryCandidates)
    ? normalized.memoryCandidates
    : []) {
    const memory = normalizeCandidate(candidate);
    if (!memory) continue;
    applied.push(
      store.upsertLongTermMemory({
        type: memory.type,
        content: memory.content,
        source: memory.reason || "auto-summary",
        confidence: memory.confidence,
        importance: memory.importance,
        status: memory.rememberLongTerm ? "active" : "needs_review",
      }),
    );
  }

  for (const content of Array.isArray(normalized.styleAdjustments)
    ? normalized.styleAdjustments.map(normalizeText).filter(Boolean)
    : []) {
    applied.push(
      store.upsertLongTermMemory({
        type: "style_memory",
        content,
        source: "auto-summary-style",
        confidence: 0.8,
        importance: 3,
        status: "active",
      }),
    );
  }

  return {
    shortTermSummary: store.getStreamSummary(),
    appliedMemories: applied.filter(Boolean),
  };
}
