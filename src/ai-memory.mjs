import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function sanitizeLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 30;
  }
  return parsed;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function mapDanmakuRow(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind || "danmaku",
    userId: row.user_id,
    userName: row.user_name,
    text: row.text,
    receivedAt: row.received_at,
    source: row.source,
    status: row.status,
  };
}

function mapQueuedSegmentRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    segmentIndex: row.segment_index,
    text: row.text,
    status: row.status,
  };
}

function mapReplyTaskRow(row) {
  return {
    id: row.id,
    source: row.source,
    targetUserId: row.target_user_id,
    targetUserName: row.target_user_name,
    sourceMessageIds: parseJsonArray(row.source_message_ids),
    originalReply: row.original_reply,
    status: row.status,
  };
}

function mapConversationEventRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.user_id || "",
    userName: row.user_name || "",
    text: row.text,
    metadata: parseJsonObject(row.metadata_json || "{}"),
    createdAt: row.created_at,
  };
}

function mapLongTermMemoryRow(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    source: row.source || "",
    confidence: Number(row.confidence || 0),
    importance: Number(row.importance || 0),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    hitCount: Number(row.hit_count || 0),
    status: row.status,
  };
}

function mapMemoryRevisionRow(row) {
  return {
    id: row.id,
    summary: row.summary,
    source: row.source || "",
    createdAt: row.created_at,
  };
}

function normalizeMemoryType(type) {
  const value = String(type || "").trim();
  return MEMORY_TYPES.has(value) ? value : "fact_memory";
}

function normalizeMemoryStatus(status) {
  const value = String(status || "").trim();
  return MEMORY_STATUSES.has(value) ? value : "needs_review";
}

function normalizeMemoryScore(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function stringifyMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "{}";
  }
  return JSON.stringify(metadata);
}

function tokenizeMemorySearchText(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return [];
  const tokens = new Set();
  for (const word of normalized.split(/\s+/u)) {
    if (!word) continue;
    tokens.add(word);
    if (/[\u4e00-\u9fff]/u.test(word)) {
      for (let size = 2; size <= 4; size += 1) {
        for (let index = 0; index <= word.length - size; index += 1) {
          tokens.add(word.slice(index, index + size));
        }
      }
    }
  }
  return [...tokens].filter((token) => token.length >= 2);
}

const MEMORY_SEARCH_STOP_TOKENS = new Set([
  "直播",
  "直播间",
  "观众",
  "正在",
  "最近",
  "话题",
  "问题",
  "回复",
  "雪风",
  "大家",
  "这个",
  "那个",
  "一下",
  "怎么",
  "什么",
  "可以",
]);

function isMemorySearchStopToken(token) {
  if (MEMORY_SEARCH_STOP_TOKENS.has(token)) return true;
  for (const stopToken of MEMORY_SEARCH_STOP_TOKENS) {
    if (stopToken.includes(token) || token.includes(stopToken)) return true;
  }
  return false;
}

function memorySearchScore(memory, queryTokens) {
  const usefulTokens = queryTokens.filter(
    (token) => !isMemorySearchStopToken(token),
  );
  if (!usefulTokens.length) return 0;
  const haystack = `${memory.type} ${memory.content} ${memory.source}`.toLowerCase();
  let score = 0;
  for (const token of usefulTokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 2 : 1;
    }
  }
  if (score <= 0) return 0;
  return (
    score * 10 +
    Number(memory.importance || 0) * 2 +
    Number(memory.hitCount || 0) +
    Number(memory.confidence || 0)
  );
}

function compareImportantMemories(left, right) {
  const importance = Number(right.importance || 0) - Number(left.importance || 0);
  if (importance !== 0) return importance;
  const hits = Number(right.hitCount || 0) - Number(left.hitCount || 0);
  if (hits !== 0) return hits;
  return String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const CURRENT_TIMESTAMP_DEFAULT = "CURRENT_TIMESTAMP";
const MEMORY_TYPES = new Set([
  "viewer_memory",
  "stream_memory",
  "style_memory",
  "topic_memory",
  "fact_memory",
]);
const MEMORY_STATUSES = new Set(["active", "archived", "needs_review"]);

const TABLE_SCHEMAS = Object.freeze([
  {
    name: "danmaku_messages",
    columns: [
      "id",
      "room_id",
      "kind",
      "user_id",
      "user_name",
      "text",
      "received_at",
      "source",
      "status",
      "created_at",
    ],
    required: [
      "id",
      "room_id",
      "kind",
      "user_id",
      "user_name",
      "text",
      "received_at",
      "source",
      "status",
      "created_at",
    ],
    defaults: {
      kind: "'danmaku'",
      status: "'unclaimed'",
      created_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE danmaku_messages (
        id TEXT PRIMARY KEY NOT NULL,
        room_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'danmaku',
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unclaimed',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "reply_tasks",
    columns: [
      "id",
      "source",
      "target_user_id",
      "target_user_name",
      "source_message_ids",
      "original_reply",
      "status",
      "created_at",
      "updated_at",
    ],
    required: [
      "id",
      "source",
      "source_message_ids",
      "original_reply",
      "status",
      "created_at",
      "updated_at",
    ],
    defaults: {
      source_message_ids: "'[]'",
      original_reply: "''",
      created_at: CURRENT_TIMESTAMP_DEFAULT,
      updated_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE reply_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        target_user_id TEXT,
        target_user_name TEXT,
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        original_reply TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "reply_segments",
    columns: [
      "id",
      "task_id",
      "segment_index",
      "text",
      "status",
      "created_at",
      "updated_at",
    ],
    required: [
      "id",
      "task_id",
      "segment_index",
      "text",
      "status",
      "created_at",
      "updated_at",
    ],
    defaults: {
      status: "'queued'",
      created_at: CURRENT_TIMESTAMP_DEFAULT,
      updated_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    foreignKeys: [
      {
        from: "task_id",
        table: "reply_tasks",
        to: "id",
      },
    ],
    createSql: `
      CREATE TABLE reply_segments (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES reply_tasks(id),
        segment_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "conversation_events",
    columns: [
      "id",
      "kind",
      "user_id",
      "user_name",
      "text",
      "metadata_json",
      "created_at",
    ],
    required: ["id", "kind", "text", "metadata_json", "created_at"],
    defaults: {
      metadata_json: "'{}'",
      created_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE conversation_events (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "viewer_memories",
    columns: ["user_id", "user_name", "summary", "updated_at"],
    required: ["user_id", "user_name", "summary", "updated_at"],
    defaults: {
      summary: "''",
      updated_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE viewer_memories (
        user_id TEXT PRIMARY KEY NOT NULL,
        user_name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "stream_memory",
    columns: ["id", "summary", "updated_at"],
    required: ["summary", "updated_at"],
    defaults: {
      summary: "''",
      updated_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE stream_memory (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "long_term_memory",
    columns: ["id", "summary", "updated_at"],
    required: ["summary", "updated_at"],
    defaults: {
      summary: "''",
      updated_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE long_term_memory (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "long_term_memories",
    columns: [
      "id",
      "type",
      "content",
      "source",
      "confidence",
      "importance",
      "first_seen_at",
      "last_seen_at",
      "hit_count",
      "status",
    ],
    required: [
      "id",
      "type",
      "content",
      "source",
      "confidence",
      "importance",
      "first_seen_at",
      "last_seen_at",
      "hit_count",
      "status",
    ],
    defaults: {
      source: "''",
      confidence: "0.5",
      importance: "1",
      first_seen_at: CURRENT_TIMESTAMP_DEFAULT,
      last_seen_at: CURRENT_TIMESTAMP_DEFAULT,
      hit_count: "1",
      status: "'needs_review'",
    },
    createSql: `
      CREATE TABLE long_term_memories (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        importance INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        hit_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'needs_review'
      )
    `,
  },
  {
    name: "memory_summary_revisions",
    columns: ["id", "summary", "source", "created_at"],
    required: ["id", "summary", "source", "created_at"],
    defaults: {
      summary: "''",
      source: "'manual'",
      created_at: CURRENT_TIMESTAMP_DEFAULT,
    },
    createSql: `
      CREATE TABLE memory_summary_revisions (
        id TEXT PRIMARY KEY NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
]);

export class AiMemoryStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      for (const schema of TABLE_SCHEMAS) {
        this.ensureTable(schema);
      }
      this.cleanupOrphanSegments();
      this.verifyForeignKeys();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  ensureTable(schema) {
    if (!this.tableExists(schema.name)) {
      this.db.exec(schema.createSql);
      return;
    }
    if (!this.tableNeedsRebuild(schema)) {
      return;
    }
    this.rebuildTable(schema);
  }

  tableExists(name) {
    return Boolean(
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name),
    );
  }

  tableNeedsRebuild(schema) {
    const columns = new Map(
      this.db
        .prepare(`PRAGMA table_info(${quoteIdentifier(schema.name)})`)
        .all()
        .map((column) => [column.name, column]),
    );
    for (const name of schema.columns) {
      if (!columns.has(name)) return true;
    }
    for (const name of schema.required) {
      if (columns.get(name)?.notnull !== 1) return true;
    }
    for (const [name, expected] of Object.entries(schema.defaults)) {
      if (columns.get(name)?.dflt_value !== expected) return true;
    }
    for (const foreignKey of schema.foreignKeys || []) {
      const matches = this.db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(schema.name)})`)
        .all()
        .some(
          (row) =>
            row.from === foreignKey.from &&
            row.table === foreignKey.table &&
            row.to === foreignKey.to,
        );
      if (!matches) return true;
    }
    return false;
  }

  rebuildTable(schema) {
    const oldName = `__old_${schema.name}_${Date.now()}`;
    const oldTable = quoteIdentifier(oldName);
    const newTable = quoteIdentifier(schema.name);
    this.db.exec("BEGIN");
    try {
      this.db.exec(`ALTER TABLE ${newTable} RENAME TO ${oldTable}`);
      this.db.exec(schema.createSql);
      this.copyTableRows(schema, oldName);
      this.db.exec(`DROP TABLE ${oldTable}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  copyTableRows(schema, oldName) {
    const oldTable = quoteIdentifier(oldName);
    const oldColumns = new Set(
      this.db
        .prepare(`PRAGMA table_info(${oldTable})`)
        .all()
        .map((column) => column.name),
    );
    const insertColumns = schema.columns.map(quoteIdentifier).join(", ");
    const selectColumns = schema.columns
      .map((column) =>
        oldColumns.has(column)
          ? `${oldTable}.${quoteIdentifier(column)}`
          : (schema.defaults[column] ?? "NULL"),
      )
      .join(", ");
    const requiredChecks = schema.required
      .filter((column) => oldColumns.has(column))
      .map((column) => `${oldTable}.${quoteIdentifier(column)} IS NOT NULL`);
    if (schema.name === "reply_segments" && oldColumns.has("task_id")) {
      requiredChecks.push(
        `EXISTS (
          SELECT 1 FROM reply_tasks
          WHERE reply_tasks.id = ${oldTable}.${quoteIdentifier("task_id")}
        )`,
      );
    }
    const where = requiredChecks.length
      ? ` WHERE ${requiredChecks.join(" AND ")}`
      : "";

    this.db.exec(`
      INSERT OR IGNORE INTO ${quoteIdentifier(schema.name)} (${insertColumns})
      SELECT ${selectColumns}
      FROM ${oldTable}${where}
    `);
  }

  cleanupOrphanSegments() {
    this.db.exec(`
      DELETE FROM reply_segments
      WHERE NOT EXISTS (
        SELECT 1 FROM reply_tasks
        WHERE reply_tasks.id = reply_segments.task_id
      )
    `);
  }

  verifyForeignKeys() {
    const violations = this.db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `AI memory schema has ${violations.length} foreign key violation(s)`,
      );
    }
  }

  recordDanmaku(message) {
    return this.recordActionableEvent({
      ...message,
      kind: message.kind || "danmaku",
    });
  }

  recordActionableEvent(event) {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO danmaku_messages (
          id,
          room_id,
          kind,
          user_id,
          user_name,
          text,
          received_at,
          source,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.roomId,
        event.kind || "event",
        event.userId || "",
        event.userName || "",
        event.text,
        event.receivedAt || event.createdAt || new Date().toISOString(),
        event.source || "bilibili",
        event.status ?? "unclaimed",
      );
    return { inserted: result.changes === 1 };
  }

  getUnclaimedMessages({ limit = 30 } = {}) {
    const rows = this.db
      .prepare(`
        SELECT id, room_id, kind, user_id, user_name, text, received_at, source, status
        FROM danmaku_messages
        WHERE status = 'unclaimed'
        ORDER BY received_at ASC
        LIMIT ?
      `)
      .all(sanitizeLimit(limit));
    return rows.map(mapDanmakuRow);
  }

  markMessagesStatus(ids, status) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return;
    }
    const statement = this.db.prepare(`
      UPDATE danmaku_messages
      SET status = ?
      WHERE id = ?
    `);
    for (const id of ids) {
      statement.run(status, id);
    }
  }

  recordConversationEvent(event) {
    const id = String(event.id || crypto.randomUUID());
    const createdAt =
      event.createdAt || event.receivedAt || new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO conversation_events (
          id,
          kind,
          user_id,
          user_name,
          text,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        String(event.kind || "event"),
        event.userId ? String(event.userId) : null,
        event.userName ? String(event.userName) : null,
        String(event.text || ""),
        stringifyMetadata(event.metadata),
        String(createdAt),
      );
    return { id, inserted: result.changes === 1 };
  }

  recordSearchResult(search) {
    const query = String(search.query || "").trim();
    const provider = String(search.provider || "").trim() || "web_search";
    const results = Array.isArray(search.results) ? search.results : [];
    const summary = results
      .slice(0, 3)
      .map((result, index) => {
        const title = String(result.title || `result-${index + 1}`).trim();
        const snippet = String(result.snippet || result.content || "").trim();
        return snippet ? `${title}: ${snippet}` : title;
      })
      .filter(Boolean)
      .join("\n");
    return this.recordConversationEvent({
      id: search.id || `tool-search-${crypto.randomUUID()}`,
      kind: "tool_search",
      text: summary ? `搜索：${query}\n${summary}` : `搜索：${query}`,
      createdAt: search.createdAt || new Date().toISOString(),
      metadata: {
        query,
        provider,
        results,
        source: search.source || "mcp",
      },
    });
  }

  getRecentConversationEvents({ limit = 100 } = {}) {
    const rows = this.db
      .prepare(`
        SELECT id, kind, user_id, user_name, text, metadata_json, created_at
        FROM (
          SELECT rowid, id, kind, user_id, user_name, text, metadata_json, created_at
          FROM conversation_events
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        )
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(sanitizeLimit(limit));
    return rows.map(mapConversationEventRow);
  }

  trimConversationEvents(limit = 300) {
    const result = this.db
      .prepare(`
        DELETE FROM conversation_events
        WHERE rowid NOT IN (
          SELECT rowid
          FROM conversation_events
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        )
      `)
      .run(sanitizeLimit(limit));
    return { deleted: result.changes };
  }

  clearConversationEvents() {
    const result = this.db.prepare("DELETE FROM conversation_events").run();
    return { deleted: result.changes };
  }

  setStreamSummary(summary, { source = "manual" } = {}) {
    const normalizedSummary = String(summary || "");
    this.db
      .prepare(`
        INSERT INTO stream_memory (id, summary, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          summary = excluded.summary,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(normalizedSummary);
    this.db
      .prepare(`
        INSERT INTO memory_summary_revisions (id, summary, source)
        VALUES (?, ?, ?)
      `)
      .run(crypto.randomUUID(), normalizedSummary, String(source || "manual"));
  }

  getStreamSummary() {
    const row = this.db
      .prepare("SELECT summary FROM stream_memory WHERE id = 1")
      .get();
    return row ? String(row.summary || "") : "";
  }

  listMemoryRevisions({ limit = 20 } = {}) {
    const rows = this.db
      .prepare(`
        SELECT id, summary, source, created_at
        FROM memory_summary_revisions
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(sanitizeLimit(limit));
    return rows.map(mapMemoryRevisionRow);
  }

  restoreMemoryRevision(id) {
    const row = this.db
      .prepare("SELECT id, summary FROM memory_summary_revisions WHERE id = ?")
      .get(String(id || ""));
    if (!row) {
      return null;
    }
    this.setStreamSummary(row.summary, { source: `restore:${row.id}` });
    return this.getStreamSummary();
  }

  upsertLongTermMemory(memory) {
    const type = normalizeMemoryType(memory.type);
    const content = String(memory.content || "").trim();
    if (!content) {
      throw new Error("Memory content is required");
    }
    const source = String(memory.source || "").trim();
    const confidence = normalizeMemoryScore(memory.confidence, 0.5, 0, 1);
    const importance = Math.trunc(
      normalizeMemoryScore(memory.importance, 1, 1, 5),
    );
    const requestedStatus = normalizeMemoryStatus(memory.status);
    const now = String(memory.createdAt || new Date().toISOString());
    const existing = this.db
      .prepare(
        `
          SELECT *
          FROM long_term_memories
          WHERE type = ? AND content = ?
          ORDER BY rowid ASC
          LIMIT 1
        `,
      )
      .get(type, content);
    if (existing) {
      const hitCount = Number(existing.hit_count || 0) + 1;
      const status =
        existing.status === "active" ||
        requestedStatus === "active" ||
        hitCount >= 3
          ? "active"
          : requestedStatus;
      this.db
        .prepare(
          `
            UPDATE long_term_memories
            SET source = ?,
                confidence = ?,
                importance = ?,
                last_seen_at = ?,
                hit_count = ?,
                status = ?
            WHERE id = ?
          `,
        )
        .run(
          source || existing.source || "",
          Math.max(Number(existing.confidence || 0), confidence),
          Math.max(Number(existing.importance || 0), importance),
          now,
          hitCount,
          status,
          existing.id,
        );
      return this.getLongTermMemory(existing.id);
    }

    const id = String(memory.id || crypto.randomUUID());
    this.db
      .prepare(
        `
          INSERT INTO long_term_memories (
            id,
            type,
            content,
            source,
            confidence,
            importance,
            first_seen_at,
            last_seen_at,
            hit_count,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        type,
        content,
        source,
        confidence,
        importance,
        now,
        now,
        Math.max(1, Math.trunc(Number(memory.hitCount || 1))),
        requestedStatus,
      );
    return this.getLongTermMemory(id);
  }

  getLongTermMemory(id) {
    const row = this.db
      .prepare(
        `
          SELECT id, type, content, source, confidence, importance,
                 first_seen_at, last_seen_at, hit_count, status
          FROM long_term_memories
          WHERE id = ?
        `,
      )
      .get(String(id || ""));
    return row ? mapLongTermMemoryRow(row) : null;
  }

  listLongTermMemories({ type = "", status = "", limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push("type = ?");
      params.push(normalizeMemoryType(type));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(normalizeMemoryStatus(status));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT id, type, content, source, confidence, importance,
                 first_seen_at, last_seen_at, hit_count, status
          FROM long_term_memories
          ${where}
          ORDER BY first_seen_at ASC, rowid ASC
          LIMIT ?
        `,
      )
      .all(...params, sanitizeLimit(limit));
    return rows.map(mapLongTermMemoryRow);
  }

  listVisibleLongTermMemories(options = {}) {
    return this.listLongTermMemories({
      ...options,
      status: "active",
    });
  }

  searchRelevantLongTermMemories({
    query = "",
    limit = 12,
    styleLimit = 4,
  } = {}) {
    const visible = this.listVisibleLongTermMemories({ limit: 500 });
    const styleMemories = visible
      .filter((memory) => memory.type === "style_memory")
      .sort(compareImportantMemories)
      .slice(0, sanitizeLimit(styleLimit));
    const styleIds = new Set(styleMemories.map((memory) => memory.id));
    const queryTokens = tokenizeMemorySearchText(query);
    const matched = visible
      .filter((memory) => memory.type !== "style_memory")
      .map((memory) => ({
        memory,
        score: memorySearchScore(memory, queryTokens),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return compareImportantMemories(left.memory, right.memory);
      })
      .map((item) => item.memory);
    const selected = [];
    for (const memory of [...styleMemories, ...matched]) {
      if (selected.length >= sanitizeLimit(limit)) break;
      if (styleIds.has(memory.id) || !selected.some((item) => item.id === memory.id)) {
        selected.push(memory);
      }
    }
    return selected;
  }

  updateLongTermMemory(id, patch) {
    const existing = this.getLongTermMemory(id);
    if (!existing) return null;
    const next = {
      type: patch.type === undefined ? existing.type : normalizeMemoryType(patch.type),
      content:
        patch.content === undefined
          ? existing.content
          : String(patch.content || "").trim(),
      source:
        patch.source === undefined ? existing.source : String(patch.source || ""),
      confidence:
        patch.confidence === undefined
          ? existing.confidence
          : normalizeMemoryScore(patch.confidence, existing.confidence, 0, 1),
      importance:
        patch.importance === undefined
          ? existing.importance
          : Math.trunc(
              normalizeMemoryScore(patch.importance, existing.importance, 1, 5),
            ),
      status:
        patch.status === undefined
          ? existing.status
          : normalizeMemoryStatus(patch.status),
    };
    if (!next.content) {
      throw new Error("Memory content is required");
    }
    this.db
      .prepare(
        `
          UPDATE long_term_memories
          SET type = ?,
              content = ?,
              source = ?,
              confidence = ?,
              importance = ?,
              last_seen_at = ?,
              status = ?
          WHERE id = ?
        `,
      )
      .run(
        next.type,
        next.content,
        next.source,
        next.confidence,
        next.importance,
        new Date().toISOString(),
        next.status,
        existing.id,
      );
    return this.getLongTermMemory(existing.id);
  }

  deleteLongTermMemory(id) {
    const result = this.db
      .prepare("DELETE FROM long_term_memories WHERE id = ?")
      .run(String(id || ""));
    return { deleted: result.changes };
  }

  clearLongTermMemories({ status = "" } = {}) {
    if (status) {
      const result = this.db
        .prepare("DELETE FROM long_term_memories WHERE status = ?")
        .run(normalizeMemoryStatus(status));
      return { deleted: result.changes };
    }
    const result = this.db.prepare("DELETE FROM long_term_memories").run();
    return { deleted: result.changes };
  }

  createReplyTask(task) {
    this.db
      .prepare(`
        INSERT INTO reply_tasks (
          id,
          source,
          target_user_id,
          target_user_name,
          source_message_ids,
          original_reply,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.source,
        task.targetUserId ?? "",
        task.targetUserName ?? "",
        JSON.stringify(
          Array.isArray(task.sourceMessageIds) ? task.sourceMessageIds : [],
        ),
        task.originalReply ?? "",
        task.status ?? "queued",
      );
  }

  createReplySegments(taskId, texts) {
    if (!Array.isArray(texts)) {
      return;
    }
    const statement = this.db.prepare(`
      INSERT INTO reply_segments (
        id,
        task_id,
        segment_index,
        text,
        status
      ) VALUES (?, ?, ?, ?, 'queued')
    `);
    for (const [index, text] of texts.entries()) {
      statement.run(`${taskId}-${index}`, taskId, index, text);
    }
  }

  getQueuedSegments() {
    const rows = this.db
      .prepare(`
        SELECT id, task_id, segment_index, text, status
        FROM reply_segments
        WHERE status = 'queued'
        ORDER BY created_at ASC, segment_index ASC
      `)
      .all();
    return rows.map(mapQueuedSegmentRow);
  }

  getReplyTask(id) {
    const row = this.db
      .prepare(`
        SELECT
          id,
          source,
          target_user_id,
          target_user_name,
          source_message_ids,
          original_reply,
          status
        FROM reply_tasks
        WHERE id = ?
      `)
      .get(id);
    return row ? mapReplyTaskRow(row) : null;
  }

  markStartupInterrupted() {
    this.db
      .prepare(`
        UPDATE reply_segments
        SET status = 'interrupted',
            updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'running')
      `)
      .run();
    this.db
      .prepare(`
        UPDATE reply_tasks
        SET status = 'interrupted',
            updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'running')
      `)
      .run();
  }

  close() {
    this.db.close();
  }
}
