const PUNCTUATION = new Set(Array.from(".,!?;:，。！？；：、"));

export function buildReplyMessages({
  persona,
  currentTime = null,
  streamSummary = "",
  shortTermSummary = streamSummary,
  viewerSummary = "",
  recentEvents = [],
  longTermMemories = [],
  toolResults = [],
  selectedMessages = [],
  outputSummary = "",
  interactionIntent = {},
}) {
  return [
    {
      role: "system",
      content: [
        `Persona: ${persona || "friendly streamer"}`,
        "Write a natural spoken reply for a live stream.",
        "Persona rules have the highest priority. Do not rewrite the persona from memory.",
        "实时搜索结果 are current facts and outrank long-term memory when they conflict.",
        "Use short, conversational lines.",
        "For longer replies, insert natural semantic newlines.",
        "Each line must be one ready-to-speak segment.",
        "Interaction intent tells you whether this is a viewer reply or a room-wide line.",
        "Use persona and context to decide whether to name a viewer. Do not force a viewer name.",
        "For room audience, speak naturally to the live room rather than pretending a single viewer is private.",
        "Return only the reply text.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          shortTermSummary,
          streamSummary,
          currentTime,
          viewerSummary,
          recentEvents,
          longTermMemories,
          toolResults,
          selectedMessages,
          outputSummary,
          interactionIntent,
        },
        null,
        2,
      ),
    },
  ];
}

export function splitLongSegment(text, maxLength) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }
  const lengthLimit = normalizeMaxLength(maxLength);
  if (Array.from(trimmed).length <= lengthLimit) {
    return [trimmed];
  }

  const segments = [];
  let current = "";
  for (const char of Array.from(trimmed)) {
    current += char;
    if (PUNCTUATION.has(char)) {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) {
    segments.push(tail);
  }

  return segments.flatMap((segment) => hardSplit(segment, lengthLimit));
}

export function parseReplySegments(text, { maxLength }) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => splitLongSegment(segment, maxLength));
}

function hardSplit(text, maxLength) {
  const chars = Array.from(text);
  if (chars.length <= maxLength) {
    return [text];
  }

  const segments = [];
  for (let index = 0; index < chars.length; index += maxLength) {
    const segment = chars.slice(index, index + maxLength).join("").trim();
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

function normalizeMaxLength(maxLength) {
  const value = Math.floor(Number(maxLength));
  return value > 0 ? value : 1;
}
