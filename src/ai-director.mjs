const INVALID_DECISION = Object.freeze({
  action: "wait",
  messageIds: [],
  audience: "viewer",
  targetUserId: "",
  waitSeconds: 10,
  reason: "Director response could not be parsed; retry later.",
});

const INVALID_PROACTIVE_DECISION = Object.freeze({
  action: "wait",
  audience: "room",
  reason: "invalid proactive decision",
  wantsScreen: false,
});

export function buildDirectorMessages({
  currentTime = null,
  recentMessages,
  recentEvents = [],
  outputState,
  memorySummary,
}) {
  return [
    {
      role: "system",
      content: [
        "You are deciding whether the streamer should speak for the current live-stream events.",
        "Decide only whether to reply, whether the reply is for a viewer or the whole room, which actionable events to merge, and how long to wait.",
        "Do not reply to every room entry if it would interrupt the current conversation.",
        "Use recentEvents as context only; reply decisions must reference ids from recentMessages.",
        "For action reply, set audience to viewer or room. A room reply can leave targetUserId empty.",
        "Return JSON only. Do not include explanation outside JSON.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          currentTime,
          recentMessages,
          recentEvents,
          outputState,
          memorySummary,
          allowedActions: ["reply", "wait"],
          audiences: ["viewer", "room"],
        },
        null,
        2,
      ),
    },
  ];
}

export function parseDirectorDecision(text, { maxWaitSeconds = 120 } = {}) {
  try {
    const data = JSON.parse(String(text || ""));
    const action = data.action === "reply" ? "reply" : "wait";
    return {
      action,
      messageIds: Array.isArray(data.messageIds)
        ? data.messageIds.map(String)
        : [],
      audience: data.audience === "room" ? "room" : "viewer",
      targetUserId: String(data.targetUserId || ""),
      waitSeconds: clampWaitSeconds(data.waitSeconds, maxWaitSeconds),
      reason: String(data.reason || ""),
    };
  } catch {
    return { ...INVALID_DECISION };
  }
}

export function buildProactiveDecisionMessages({
  currentTime = null,
  recentEvents = [],
  outputState = {},
  memorySummary = "",
  sceneStatus = {},
}) {
  return [
    {
      role: "system",
      content: [
        "Decide whether the streamer should proactively speak to the live room after a quiet period.",
        "Choose speak only when there is a natural topic from the current context. Otherwise choose wait.",
        "This is a room-wide line; no viewer name is required.",
        "If you set wantsScreen to true, do not invent any visual details. A separate system may or may not provide a verified summary.",
        "Return JSON only with action, audience, reason, and wantsScreen.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          currentTime,
          recentEvents,
          outputState,
          memorySummary,
          sceneStatus,
          allowedActions: ["speak", "wait"],
          responseShape: {
            action: "speak",
            audience: "room",
            reason: "There is a natural topic to continue.",
            wantsScreen: false,
          },
        },
        null,
        2,
      ),
    },
  ];
}

export function parseProactiveDecision(text) {
  try {
    const data = JSON.parse(String(text || ""));
    return {
      action: data.action === "speak" ? "speak" : "wait",
      audience: "room",
      reason: String(data.reason || ""),
      wantsScreen: Boolean(data.wantsScreen),
    };
  } catch {
    return { ...INVALID_PROACTIVE_DECISION };
  }
}

function clampWaitSeconds(value, maxWaitSeconds) {
  const numeric = Number(value);
  const upper = Number.isFinite(Number(maxWaitSeconds))
    ? Number(maxWaitSeconds)
    : 120;
  if (!Number.isFinite(numeric)) {
    return 10;
  }
  return Math.min(Math.max(0, numeric), Math.max(0, upper));
}
