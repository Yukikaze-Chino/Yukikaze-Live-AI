export class AiChatClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.lastCache = {
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
    };
  }

  async complete({
    provider = "openai-compatible",
    baseUrl,
    apiKey,
    model,
    messages,
    json = false,
    thinkingEnabled = false,
    thinkingLevel = "high",
    timeoutSeconds = 120,
  }) {
    if (!String(apiKey || "").trim()) {
      throw new Error("AI API key is not configured");
    }
    if (!String(model || "").trim()) {
      throw new Error("AI model is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, Number(timeoutSeconds) || 120) * 1000,
    );

    try {
      const resolvedProvider = resolveAiProvider({ provider, baseUrl, model });
      if (resolvedProvider === "anthropic") {
        return await this.completeAnthropic({
          baseUrl,
          apiKey,
          model,
          messages,
          json,
          controller,
        });
      }
      return await this.completeOpenAiCompatible({
        baseUrl,
        apiKey,
        model,
        messages,
        json,
        thinkingEnabled,
        thinkingLevel,
        controller,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async completeOpenAiCompatible({
    baseUrl,
    apiKey,
    model,
    messages,
    json,
    thinkingEnabled,
    thinkingLevel,
    controller,
  }) {
      const body = {
        model,
        messages,
      };
      if (json) {
        body.response_format = { type: "json_object" };
      }
      if (thinkingEnabled) {
        body.thinking = { type: "enabled", level: thinkingLevel };
      }

      const response = await this.fetchImpl(
        `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`AI API request failed: HTTP ${response.status}`);
      }

      const payload = await response.json();
      this.lastCache = {
        promptCacheHitTokens: Number(payload?.usage?.prompt_cache_hit_tokens || 0),
        promptCacheMissTokens: Number(payload?.usage?.prompt_cache_miss_tokens || 0),
      };
      return String(payload?.choices?.[0]?.message?.content || "").trim();
  }

  async completeAnthropic({ baseUrl, apiKey, model, messages, json, controller }) {
    const body = buildAnthropicMessagesBody({ model, messages, json });
    const response = await this.fetchImpl(
      `${String(baseUrl).replace(/\/+$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`AI API request failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    this.lastCache = {
      promptCacheHitTokens: Number(payload?.usage?.cache_read_input_tokens || 0),
      promptCacheMissTokens: Number(
        payload?.usage?.cache_creation_input_tokens || 0,
      ),
    };
    return extractAnthropicText(payload).trim();
  }

  cacheStatus() {
    return { ...this.lastCache };
  }
}

function resolveAiProvider({ provider, baseUrl, model }) {
  const requested = String(provider || "").trim().toLowerCase();
  const url = String(baseUrl || "").toLowerCase();
  const modelName = String(model || "").toLowerCase();
  if (
    requested === "anthropic" ||
    url.includes("anthropic.com") ||
    modelName.startsWith("claude-")
  ) {
    return "anthropic";
  }
  return "openai-compatible";
}

function buildAnthropicMessagesBody({ model, messages = [], json = false }) {
  const systemMessages = [];
  const anthropicMessages = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message.role || "").toLowerCase();
    const content = String(message.content || "");
    if (role === "system") {
      systemMessages.push(content);
    } else if (role === "assistant" || role === "user") {
      anthropicMessages.push({ role, content });
    }
  }
  if (json) {
    systemMessages.push("Return only valid JSON. Do not wrap it in Markdown.");
  }
  return {
    model,
    max_tokens: 2048,
    ...(systemMessages.length ? { system: systemMessages.join("\n\n") } : {}),
    messages: anthropicMessages.length
      ? anthropicMessages
      : [{ role: "user", content: "" }],
  };
}

function extractAnthropicText(payload) {
  return (Array.isArray(payload?.content) ? payload.content : [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
}
