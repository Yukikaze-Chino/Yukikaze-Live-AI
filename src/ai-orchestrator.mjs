import crypto from "node:crypto";

import {
  buildCurrentTimeContext,
  localHistoryLimit,
  readVisibleAiContext,
} from "./ai-context.mjs";
import {
  buildDirectorMessages,
  buildProactiveDecisionMessages,
  parseDirectorDecision,
  parseProactiveDecision,
} from "./ai-director.mjs";
import { buildReplyMessages, parseReplySegments } from "./ai-reply.mjs";
import { LiveSceneState } from "./live-scene.mjs";
import {
  applyMemorySummaryResult,
  buildMemorySummaryMessages,
  parseMemorySummaryResult,
} from "./ai-memory-manager.mjs";
import {
  McpSearchClient,
  buildToolDecisionMessages,
  parseToolDecision,
} from "./mcp-search.mjs";

export class AiOrchestrator {
  constructor({
    configProvider,
    memory,
    secrets,
    aiClient,
    queue,
    receiver,
    searchClientFactory = null,
    scene = new LiveSceneState(),
    now = () => new Date(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.configProvider = configProvider;
    this.memory = memory;
    this.secrets = secrets;
    this.aiClient = aiClient;
    this.queue = queue;
    this.receiver = receiver;
    this.searchClientFactory = searchClientFactory;
    this.scene = scene;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.idleTimer = null;
    this.running = false;
    this.lastDecision = null;
    this.lastToolError = "";
    this.lastMemorySummaryError = "";
    this.eventsSinceSummary = 0;
    this.summaryRunning = false;
    this.searchUsageDate = "";
    this.searchesToday = 0;
    this.onReceiverLiveEvent = (event) => {
      if (!this.running) return;
      this.onLiveEvent(event.detail).catch((error) => {
        this.lastDecision = {
          action: "wait",
          messageIds: [],
          audience: "viewer",
          targetUserId: "",
          waitSeconds: 10,
          reason: error.message,
        };
      });
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.receiver.addEventListener("live-event", this.onReceiverLiveEvent);
    this.idleTimer = this.setIntervalFn(() => {
      this.tick().catch((error) => {
        this.lastDecision = {
          action: "wait",
          audience: "room",
          reason: error instanceof Error ? error.message : String(error),
          wantsScreen: false,
        };
      });
    }, 10_000);
    this.idleTimer?.unref?.();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.receiver.removeEventListener?.("live-event", this.onReceiverLiveEvent);
    if (this.idleTimer !== null) {
      this.clearIntervalFn(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async onDanmaku(message) {
    await this.onLiveEvent({
      ...message,
      kind: "danmaku",
      actionable: true,
    });
  }

  async onLiveEvent(event) {
    const config = this.configProvider();
    if (this.scene.noteInteraction(event)) {
      this.queue.cancelQueued((segment) => segment.source === "ai-idle");
    }
    if (!config.ai.enabled) return;

    let countedForSummary = false;
    try {
      const conversation = this.memory.recordConversationEvent({
        id: event.id,
        kind: event.kind || "event",
        userId: event.userId,
        userName: event.userName,
        text: event.text,
        createdAt: event.receivedAt || event.createdAt,
      });
      this.memory.trimConversationEvents(localHistoryLimit(config));
      if (conversation.inserted) {
        countedForSummary = true;
        this.eventsSinceSummary += 1;
      }
      if (!conversation.inserted || event.actionable === false) return;

      const inserted = this.memory.recordActionableEvent({
        ...event,
        status: event.status || "unclaimed",
      }).inserted;
      if (!inserted) return;

      if (!config.ai.directorEnabled) {
        await this.createReplyForMessages([event]);
        return;
      }

      await this.runDirector();
    } finally {
      if (countedForSummary) {
        await this.maybeGenerateMemorySummary(config);
      }
    }
  }

  async runDirector() {
    const config = this.configProvider();
    const now = this.now();
    const currentTime = buildCurrentTimeContext({ now });
    const recentMessages = this.memory.getUnclaimedMessages({ limit: 30 });
    if (!recentMessages.length) return;
    const recentEvents = readVisibleAiContext({
      config,
      memory: this.memory,
      now,
    });

    const content = await this.aiClient.complete({
      provider: config.ai.provider,
      baseUrl: config.ai.baseUrl,
      apiKey: this.secrets.getAiApiKey(),
      model: config.ai.model,
      messages: buildDirectorMessages({
        currentTime,
        recentMessages,
        recentEvents,
        outputState: this.queue.status(),
        memorySummary: this.memory.getStreamSummary(),
      }),
      json: true,
      thinkingEnabled: config.ai.directorThinkingEnabled,
      thinkingLevel: config.ai.thinkingLevel,
      timeoutSeconds: config.ai.requestTimeoutSeconds,
    });
    const decision = parseDirectorDecision(content);
    this.lastDecision = decision;

    if (decision.action === "reply") {
      const selected = decision.messageIds.length
        ? recentMessages.filter((message) => decision.messageIds.includes(message.id))
        : recentMessages.slice(0, 1);
      const primaryMessage = selected[0] || {};
      await this.createReplyForMessages(selected, {
        interactionIntent: {
          audience: decision.audience,
          targetUserId:
            decision.audience === "viewer"
              ? decision.targetUserId || primaryMessage.userId || ""
              : "",
          targetUserName:
            decision.audience === "viewer" ? primaryMessage.userName || "" : "",
          source: "event",
        },
      });
    }
  }

  async tick() {
    const config = this.configProvider();
    if (!config.ai.enabled || !config.ai.scene?.enabled) return;

    const idleEvent = this.scene.takeIdleCheck({ config, queue: this.queue });
    if (!idleEvent) return;

    await this.runProactiveDirector({ config, idleEvent });
  }

  async runProactiveDirector({ config, idleEvent }) {
    const now = this.now();
    const currentTime = buildCurrentTimeContext({ now });
    const recentEvents = readVisibleAiContext({
      config,
      memory: this.memory,
      now,
    });
    const content = await this.aiClient.complete({
      provider: config.ai.provider,
      baseUrl: config.ai.baseUrl,
      apiKey: this.secrets.getAiApiKey(),
      model: config.ai.model,
      messages: buildProactiveDecisionMessages({
        currentTime,
        recentEvents,
        outputState: this.queue.status(),
        memorySummary: this.memory.getStreamSummary(),
        sceneStatus: this.scene.status(),
      }),
      json: true,
      thinkingEnabled: config.ai.directorThinkingEnabled,
      thinkingLevel: config.ai.thinkingLevel,
      timeoutSeconds: config.ai.requestTimeoutSeconds,
    });
    const decision = parseProactiveDecision(content);
    this.lastDecision = { ...decision, idleEvent };
    if (decision.action !== "speak") return;

    if (decision.wantsScreen) {
      this.scene.requestScreenRead({ config });
    }
    await this.createReplyForMessages([], {
      source: "ai-idle",
      interactionIntent: {
        audience: "room",
        targetUserId: "",
        targetUserName: "",
        source: "idle",
      },
    });
  }

  async createReplyForMessages(
    messages,
    {
      interactionIntent = {
        audience: "viewer",
        targetUserId: "",
        targetUserName: "",
        source: "event",
      },
      source = null,
    } = {},
  ) {
    const config = this.configProvider();
    const now = this.now();
    const currentTime = buildCurrentTimeContext({ now });
    const streamSummary = this.memory.getStreamSummary();
    const recentEvents = readVisibleAiContext({
      config,
      memory: this.memory,
      now,
    });
    const longTermMemories = selectRelevantLongTermMemories({
      memory: this.memory,
      streamSummary,
      messages,
      recentEvents,
    });
    const sourceMessageIds = messages.map((message) => message.id);
    if (sourceMessageIds.length) {
      this.memory.markMessagesStatus(sourceMessageIds, "claimed");
    }
    const toolResults = await this.maybeUseSearch({
      config,
      messages,
      recentEvents,
      streamSummary,
      longTermMemories,
    });
    const replyRecentEvents = toolResults.length
      ? readVisibleAiContext({ config, memory: this.memory, now: new Date() })
      : recentEvents;
    const content = await this.aiClient.complete({
      provider: config.ai.provider,
      baseUrl: config.ai.baseUrl,
      apiKey: this.secrets.getAiApiKey(),
      model: config.ai.model,
      messages: buildReplyMessages({
        persona: config.ai.persona,
        currentTime,
        streamSummary,
        shortTermSummary: streamSummary,
        recentEvents: replyRecentEvents,
        longTermMemories,
        toolResults,
        selectedMessages: messages,
        outputSummary: JSON.stringify(this.queue.status()),
        interactionIntent,
      }),
      json: false,
      thinkingEnabled: config.ai.replyThinkingEnabled,
      thinkingLevel: config.ai.thinkingLevel,
      timeoutSeconds: config.ai.requestTimeoutSeconds,
    });
    const segments = parseReplySegments(content, {
      maxLength: config.danmakuMaxLength || 30,
    });
    if (!segments.length) return;

    const taskId = crypto.randomUUID();
    const replySource =
      source ||
      (messages.some((message) => message.source === "local-test")
        ? "ai-test"
        : "ai");
    const audience = interactionIntent.audience === "room" ? "room" : "viewer";
    const primaryMessage = messages[0] || {};
    const targetUserId =
      audience === "viewer"
        ? String(interactionIntent.targetUserId || primaryMessage.userId || "")
        : "";
    const targetUserName =
      audience === "viewer"
        ? String(interactionIntent.targetUserName || primaryMessage.userName || "")
        : "";
    if (replySource !== "ai-idle") {
      this.queue.cancelQueued((segment) => segment.source === "ai-idle");
    }
    this.memory.recordConversationEvent({
      id: taskId,
      kind: "ai_reply",
      userId: targetUserId,
      userName: targetUserName,
      text: segments.join("\n"),
    });
    this.memory.trimConversationEvents(localHistoryLimit(config));
    this.memory.createReplyTask({
      id: taskId,
      source: replySource,
      targetUserId,
      targetUserName,
      sourceMessageIds,
      originalReply: content,
      status: "queued",
    });
    this.memory.createReplySegments(taskId, segments);
    this.queue.enqueueTask({
      id: taskId,
      priority: replySource === "ai-idle" ? "idle" : "normal",
      segments: segments.map((text, index) => ({
        id: `${taskId}-${index}`,
        text,
        source: replySource,
      })),
      segmentDelaySeconds: 0,
    });
    await this.queue.drain();
  }

  async maybeUseSearch({
    config,
    messages,
    recentEvents,
    streamSummary,
    longTermMemories,
  }) {
    const tools = config.ai.tools || {};
    const webSearch = tools.webSearch || {};
    if (
      !tools.enabled ||
      !tools.autoUseTools ||
      !webSearch.enabled ||
      !webSearch.endpoint ||
      Math.trunc(Number(tools.maxSearchesPerReply) || 0) < 1 ||
      !this.hasSearchQuota(tools.dailySearchLimit)
    ) {
      return [];
    }
    try {
      const decisionContent = await this.aiClient.complete({
        provider: config.ai.provider,
        baseUrl: config.ai.baseUrl,
        apiKey: this.secrets.getAiApiKey(),
        model: config.ai.model,
        messages: buildToolDecisionMessages({
          selectedMessages: messages,
          recentEvents,
          shortTermSummary: streamSummary,
          longTermMemories,
        }),
        json: true,
        thinkingEnabled: false,
        thinkingLevel: config.ai.thinkingLevel,
        timeoutSeconds: config.ai.requestTimeoutSeconds,
      });
      const decision = parseToolDecision(decisionContent);
      if (!decision.useTool) {
        this.lastToolError = "";
        return [];
      }
      const credentials = this.secrets.getTencentCloudCredentials?.() || {};
      const client =
        this.searchClientFactory?.({
          config,
          decision,
          credentials,
        }) ||
        new McpSearchClient({
          endpoint: webSearch.endpoint,
          provider: webSearch.provider,
          transport: webSearch.transport,
          secretId: credentials.secretId,
          secretKey: credentials.secretKey,
        });
      const search = await client.search({
        query: decision.query,
        maxResults: webSearch.maxResults,
      });
      if (search.results.length > 0 && decision.rememberShortTerm) {
        this.memory.recordSearchResult(search);
        this.memory.trimConversationEvents(localHistoryLimit(config));
      }
      this.recordSearchUse();
      this.lastToolError = "";
      return [search];
    } catch (error) {
      this.lastToolError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  hasSearchQuota(limit) {
    const dailyLimit = Math.trunc(Number(limit) || 0);
    if (dailyLimit < 1) return true;
    const today = new Date().toISOString().slice(0, 10);
    if (this.searchUsageDate !== today) {
      this.searchUsageDate = today;
      this.searchesToday = 0;
    }
    return this.searchesToday < dailyLimit;
  }

  recordSearchUse() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.searchUsageDate !== today) {
      this.searchUsageDate = today;
      this.searchesToday = 0;
    }
    this.searchesToday += 1;
  }

  async maybeGenerateMemorySummary(config) {
    const interval = Math.trunc(Number(config.ai.memorySummaryInterval) || 50);
    if (interval < 1 || this.eventsSinceSummary < interval || this.summaryRunning) {
      return;
    }
    this.summaryRunning = true;
    try {
      const recentEvents = readVisibleAiContext({
        config,
        memory: this.memory,
      });
      const longTermMemories = this.memory.listLongTermMemories?.({
        status: "active",
        limit: 100,
      }) || [];
      const content = await this.aiClient.complete({
        provider: config.ai.provider,
        baseUrl: config.ai.baseUrl,
        apiKey: this.secrets.getAiApiKey(),
        model: config.ai.model,
        messages: buildMemorySummaryMessages({
          persona: config.ai.persona,
          shortTermSummary: this.memory.getStreamSummary(),
          recentEvents,
          longTermMemories,
        }),
        json: true,
        thinkingEnabled: false,
        thinkingLevel: config.ai.thinkingLevel,
        timeoutSeconds: config.ai.requestTimeoutSeconds,
      });
      applyMemorySummaryResult(
        this.memory,
        parseMemorySummaryResult(content),
      );
      this.eventsSinceSummary = 0;
      this.lastMemorySummaryError = "";
    } catch (error) {
      this.lastMemorySummaryError =
        error instanceof Error ? error.message : String(error);
    } finally {
      this.summaryRunning = false;
    }
  }

  status() {
    return {
      running: this.running,
      lastDecision: this.lastDecision,
      queue: this.queue.status(),
      receiver: this.receiver.currentStatus(),
      scene: this.sceneStatus(),
      cache: this.aiClient.cacheStatus?.() || null,
      lastToolError: this.lastToolError,
      lastMemorySummaryError: this.lastMemorySummaryError,
      searchUsage: {
        date: this.searchUsageDate,
        searchesToday: this.searchesToday,
        dailyLimit: this.configProvider().ai.tools?.dailySearchLimit || 0,
      },
    };
  }

  sceneStatus() {
    return this.scene.status();
  }
}

function selectRelevantLongTermMemories({
  memory,
  streamSummary = "",
  messages = [],
  recentEvents = [],
}) {
  const query = buildLongTermMemorySearchQuery({
    streamSummary,
    messages,
    recentEvents,
  });
  if (typeof memory.searchRelevantLongTermMemories === "function") {
    return memory.searchRelevantLongTermMemories({ query, limit: 12 });
  }
  return (
    (memory.listVisibleLongTermMemories || memory.listLongTermMemories)?.call(
      memory,
      {
        status: "active",
        limit: 12,
      },
    ) || []
  );
}

function buildLongTermMemorySearchQuery({
  streamSummary = "",
  messages = [],
  recentEvents = [],
}) {
  const selectedText = messages
    .map((message) => `${message.userName || ""} ${message.text || ""}`)
    .join("\n");
  const recentText = recentEvents
    .slice(-20)
    .map((event) => `${event.userName || ""} ${event.text || ""}`)
    .join("\n");
  return [streamSummary, selectedText, recentText].filter(Boolean).join("\n");
}
