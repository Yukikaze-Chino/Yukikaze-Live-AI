function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(stripJsonFence(value));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeResultItem(item) {
  if (typeof item === "string") {
    const parsed = parseJson(item, null);
    if (parsed) return normalizeResultItem(parsed);
    return normalizeResultItem({ snippet: item });
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  const title = normalizeText(item.title || item.name || item.heading);
  const url = normalizeText(item.url || item.link || item.href);
  const snippet = normalizeText(
    item.snippet ||
      item.summary ||
      item.content ||
      item.description ||
      item.passage,
  );
  const source = normalizeText(item.source || item.site || item.provider);
  const publishedAt = normalizeText(
    item.publishedAt || item.published_at || item.date || item.time,
  );
  if (!title && !url && !snippet) {
    return null;
  }
  return { title, url, snippet, source, publishedAt };
}

function extractResultArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (Array.isArray(payload.results)) {
    return payload.results;
  }
  if (Array.isArray(payload.items)) {
    return payload.items;
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.data?.results)) {
    return payload.data.results;
  }
  if (Array.isArray(payload.Response?.Pages)) {
    return payload.Response.Pages;
  }
  if (Array.isArray(payload.response?.pages)) {
    return payload.response.pages;
  }
  return [];
}

function isTencentProvider(provider) {
  return normalizeText(provider).toLowerCase().includes("tencent");
}

export function buildToolDecisionMessages({
  selectedMessages = [],
  recentEvents = [],
  shortTermSummary = "",
} = {}) {
  return [
    {
      role: "system",
      content: [
        "Decide whether Yukikaze needs web_search before replying.",
        "Use search only for current facts, external rules, news, weather, prices, or unknown factual questions.",
        "Return JSON only.",
        "Schema: {\"useTool\":boolean,\"toolName\":\"web_search\",\"query\":\"\",\"reason\":\"\",\"rememberShortTerm\":boolean}",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          shortTermSummary,
          recentEvents,
          selectedMessages,
        },
        null,
        2,
      ),
    },
  ];
}

export function parseToolDecision(text) {
  const parsed = parseJson(text, {});
  const toolName = normalizeText(parsed.toolName || parsed.tool || "web_search");
  const query = normalizeText(parsed.query);
  return {
    useTool: Boolean(parsed.useTool && query && toolName === "web_search"),
    toolName,
    query,
    reason: normalizeText(parsed.reason),
    rememberShortTerm: Boolean(parsed.rememberShortTerm),
  };
}

export function normalizeMcpSearchResult(result) {
  const candidates = [];
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part?.type === "text") {
        const parsed = parseJson(part.text, null);
        if (parsed) {
          candidates.push(...extractResultArray(parsed));
        } else {
          candidates.push({
            title: "",
            url: "",
            snippet: normalizeText(part.text),
            source: "",
          });
        }
      }
    }
  } else {
    candidates.push(...extractResultArray(result));
  }
  return candidates.map(normalizeResultItem).filter(Boolean);
}

export function detectMcpTransportType({ endpoint = "", transport = "" } = {}) {
  const requested = normalizeText(transport).toLowerCase();
  const url = normalizeText(endpoint).toLowerCase();
  if (requested === "sse" || /\/sse(?:\/|$)/.test(url)) {
    return "sse";
  }
  return "streamable_http";
}

async function createSdkClient({
  endpoint,
  secretId = "",
  secretKey = "",
  transport = "",
  clientName = "yukikaze-dialogue-bridge",
} = {}) {
  if (!endpoint) {
    throw new Error("MCP search endpoint is not configured");
  }
  const [{ Client }, transportModule] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    detectMcpTransportType({ endpoint, transport }) === "sse"
      ? import("@modelcontextprotocol/sdk/client/sse.js")
      : import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const headers = {};
  if (secretId) headers["X-TC-SecretId"] = secretId;
  if (secretKey) headers["X-TC-SecretKey"] = secretKey;
  const requestInit = { headers };
  const clientTransport =
    detectMcpTransportType({ endpoint, transport }) === "sse"
      ? new transportModule.SSEClientTransport(new URL(endpoint), {
          requestInit,
        })
      : new transportModule.StreamableHTTPClientTransport(new URL(endpoint), {
          requestInit,
        });
  const client = new Client(
    { name: clientName, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

export class McpSearchClient {
  constructor({
    endpoint = "",
    secretId = "",
    secretKey = "",
    provider = "tencent-wsa-mcp",
    transport = "",
    createClient = null,
  } = {}) {
    this.endpoint = endpoint;
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.provider = provider;
    this.transport = transport;
    this.createClient = createClient;
  }

  async search({ query, maxResults = 5 } = {}) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      return {
        query: "",
        provider: this.provider,
        createdAt: new Date().toISOString(),
        results: [],
      };
    }
    const clientFactory =
      this.createClient ||
      (() =>
        createSdkClient({
          endpoint: this.endpoint,
          secretId: this.secretId,
          secretKey: this.secretKey,
          transport: this.transport,
        }));
    const client = await clientFactory();
    try {
      const useTencentSearch = isTencentProvider(this.provider);
      const response = await client.callTool({
        name: useTencentSearch ? "wsa-SearchPro" : "web_search",
        arguments: useTencentSearch
          ? { Query: normalizedQuery }
          : {
              query: normalizedQuery,
              maxResults: Math.max(1, Math.trunc(Number(maxResults) || 5)),
            },
      });
      const resultLimit = Math.max(1, Math.trunc(Number(maxResults) || 5));
      return {
        query: normalizedQuery,
        provider: this.provider,
        createdAt: new Date().toISOString(),
        results: normalizeMcpSearchResult(response).slice(0, resultLimit),
      };
    } finally {
      await client.close?.();
    }
  }
}
