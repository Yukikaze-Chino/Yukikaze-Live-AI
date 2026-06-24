const MAX_ENTRIES = 80;

function sanitizeMusicMessage(value) {
  return String(value || "")
    .replace(/(?:sk|AKID)[-_A-Za-z0-9]{8,}/g, "[已隐藏]")
    .trim()
    .slice(0, 600);
}

function sanitizeMusicColor(value) {
  const color = String(value || "Gray").trim();
  return /^[A-Za-z]+$/.test(color) ? color : "Gray";
}

function sanitizeMusicTime(value) {
  const time = String(value || "").trim();
  return /^\d{1,2}:\d{2}:\d{2}$/.test(time) ? time : "";
}

export class BiliMusicLogStore {
  #entries = [];
  #lastSignatures = new Map();

  record({ kind, message, createdAt = new Date().toISOString() } = {}) {
    const normalizedKind = String(kind || "").trim();
    const normalizedMessage = sanitizeMusicMessage(message);
    if (!normalizedKind.startsWith("music_") || !normalizedMessage) {
      return this.current();
    }
    const signature = `${normalizedKind}:${normalizedMessage}`;
    if (signature === this.#lastSignatures.get(normalizedKind)) {
      return this.current();
    }
    this.#lastSignatures.set(normalizedKind, signature);
    this.#entries.push({
      id: crypto.randomUUID(),
      kind: normalizedKind,
      message: normalizedMessage,
      createdAt: String(createdAt),
    });
    this.#entries = this.#entries.slice(-MAX_ENTRIES);
    return this.current();
  }

  syncBackendLogs(entries = []) {
    const previous = new Map(
      this.#entries
        .filter((entry) => entry.kind === "music_backend")
        .map((entry) => [entry.sourceKey, entry]),
    );
    const occurrences = new Map();
    const next = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const displayTime = sanitizeMusicTime(entry?.time);
      const color = sanitizeMusicColor(entry?.color);
      const message = sanitizeMusicMessage(entry?.message);
      if (!message) continue;
      const baseKey = `${displayTime}\u0000${color}\u0000${message}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      const sourceKey = `${baseKey}\u0000${occurrence}`;
      const existing = previous.get(sourceKey);
      next.push({
        id: existing?.id || crypto.randomUUID(),
        kind: "music_backend",
        sourceKey,
        displayTime,
        color,
        message,
        createdAt: existing?.createdAt || new Date().toISOString(),
      });
    }
    this.#entries = next.slice(-MAX_ENTRIES);
    return this.current();
  }

  current({ limit = 20 } = {}) {
    const count = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(Number(limit) || 20)));
    return { entries: structuredClone(this.#entries.slice(-count)) };
  }
}
