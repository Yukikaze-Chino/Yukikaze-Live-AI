const state = {
  memory: null,
};

function $(id) {
  return document.getElementById(id);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function emptyNode(text) {
  const node = document.createElement("p");
  node.className = "muted";
  node.textContent = text;
  return node;
}

function renderRecentEvents(events) {
  const list = $("recentEventList");
  list.replaceChildren();
  if (!events?.length) {
    list.append(emptyNode("暂无短期事件"));
    return;
  }
  for (const event of events.slice(-100).reverse()) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const title = document.createElement("strong");
    title.textContent = `${event.kind}${event.userName ? ` · ${event.userName}` : ""}`;
    const body = document.createElement("p");
    body.textContent = event.text || "";
    const meta = document.createElement("small");
    meta.textContent = event.createdAt || "";
    item.append(title, body, meta);
    list.append(item);
  }
}

function renderRevisions(revisions) {
  const list = $("memoryRevisionList");
  list.replaceChildren();
  if (!revisions?.length) {
    list.append(emptyNode("暂无总结记录"));
    return;
  }
  for (const revision of revisions) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const title = document.createElement("strong");
    title.textContent = `${revision.source || "summary"} · ${revision.createdAt || ""}`;
    const body = document.createElement("p");
    body.textContent = revision.summary || "";
    const actions = document.createElement("div");
    actions.className = "actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "secondary";
    restore.textContent = "回滚到此版本";
    restore.addEventListener("click", () => restoreMemoryRevision(revision.id));
    actions.append(restore);
    item.append(title, body, actions);
    list.append(item);
  }
}

function createMemoryEditor(memory) {
  const item = document.createElement("div");
  item.className = "memory-item";

  const heading = document.createElement("strong");
  heading.textContent = `${memory.type} · ${memory.status} · ${memory.hitCount || 1} 次`;

  const content = document.createElement("textarea");
  content.rows = 3;
  content.value = memory.content || "";

  const controls = document.createElement("div");
  controls.className = "two";

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "类型";
  const type = document.createElement("select");
  for (const [value, label] of [
    ["viewer_memory", "观众"],
    ["stream_memory", "直播"],
    ["style_memory", "风格"],
    ["topic_memory", "话题"],
    ["fact_memory", "事实"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === memory.type;
    type.append(option);
  }
  typeLabel.append(type);

  const statusLabel = document.createElement("label");
  statusLabel.textContent = "状态";
  const status = document.createElement("select");
  for (const [value, label] of [
    ["active", "启用"],
    ["needs_review", "待确认"],
    ["archived", "归档"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === memory.status;
    status.append(option);
  }
  statusLabel.append(status);
  controls.append(typeLabel, statusLabel);

  const meta = document.createElement("small");
  meta.textContent = [
    `importance ${memory.importance}`,
    `confidence ${memory.confidence}`,
    memory.source,
    memory.lastSeenAt,
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = document.createElement("div");
  actions.className = "actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "保存";
  save.addEventListener("click", async () => {
    await api("/api/ai/memory/long-term", {
      method: "PUT",
      body: JSON.stringify({
        id: memory.id,
        type: type.value,
        status: status.value,
        content: content.value,
      }),
    });
    await refreshMemory();
  });
  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "secondary";
  archive.textContent = "归档";
  archive.addEventListener("click", async () => {
    await api("/api/ai/memory/long-term", {
      method: "PUT",
      body: JSON.stringify({ id: memory.id, status: "archived" }),
    });
    await refreshMemory();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    await api("/api/ai/memory/long-term", {
      method: "DELETE",
      body: JSON.stringify({ id: memory.id }),
    });
    await refreshMemory();
  });
  actions.append(save, archive, remove);

  item.append(heading, content, controls, meta, actions);
  return item;
}

function renderMemoryList(id, memories, emptyText) {
  const list = $(id);
  list.replaceChildren();
  if (!memories?.length) {
    list.append(emptyNode(emptyText));
    return;
  }
  for (const memory of memories) {
    list.append(createMemoryEditor(memory));
  }
}

async function refreshMemory() {
  const type = $("memoryTypeFilter")?.value || "";
  const payload = await api(
    `/api/ai/memory/summary${type ? `?type=${encodeURIComponent(type)}` : ""}`,
  );
  state.memory = payload.memory;
  $("memorySummary").value = payload.memory.summary || "";
  renderMemoryList("longTermMemoryList", payload.memory.longTerm, "暂无长期记忆");
  renderMemoryList(
    "pendingMemoryList",
    payload.memory.pending,
    "雪风会自动处理候选记忆，无需逐条确认",
  );
  renderRecentEvents(payload.memory.recentEvents);
  renderRevisions(payload.memory.revisions);
}

async function restoreMemoryRevision(id) {
  await api("/api/ai/memory/revisions/restore", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  await refreshMemory();
}

async function saveMemorySummary() {
  await api("/api/ai/memory/summary", {
    method: "PUT",
    body: JSON.stringify({ summary: $("memorySummary").value }),
  });
  await refreshMemory();
}

async function generateMemorySummary() {
  await api("/api/ai/memory/summary/generate", { method: "POST" });
  await refreshMemory();
}

async function addLongTermMemory() {
  await api("/api/ai/memory/long-term", {
    method: "POST",
    body: JSON.stringify({
      type: $("newMemoryType").value,
      status: $("newMemoryStatus").value,
      content: $("newMemoryContent").value,
      source: "manual",
    }),
  });
  $("newMemoryContent").value = "";
  await refreshMemory();
}

async function clearShortTermMemory() {
  await api("/api/ai/memory/short-term/clear", { method: "POST" });
  await refreshMemory();
}

async function clearLongTermMemory() {
  await api("/api/ai/memory/long-term/clear", { method: "POST", body: "{}" });
  await refreshMemory();
}

window.refreshMemory = refreshMemory;
window.restoreMemoryRevision = restoreMemoryRevision;

document.addEventListener("DOMContentLoaded", () => {
  $("refreshMemoryButton").addEventListener("click", refreshMemory);
  $("saveMemorySummaryButton").addEventListener("click", saveMemorySummary);
  $("generateMemorySummaryButton").addEventListener(
    "click",
    generateMemorySummary,
  );
  $("addLongTermMemoryButton").addEventListener("click", addLongTermMemory);
  $("clearShortTermMemoryButton").addEventListener(
    "click",
    clearShortTermMemory,
  );
  $("clearLongTermMemoryButton").addEventListener(
    "click",
    clearLongTermMemory,
  );
  $("memoryTypeFilter").addEventListener("change", refreshMemory);
  refreshMemory().catch((error) => {
    $("recentEventList").textContent = error.message;
  });
});
