export class ReplyQueue {
  constructor({ executeSegment, wait = defaultWait }) {
    this.executeSegment = executeSegment;
    this.wait = wait;
    this.queue = [];
    this.busy = false;
    this.paused = false;
    this.current = null;
  }

  enqueueTask(task) {
    const priority = task.priority === "idle" ? "idle" : "normal";
    for (const segment of task.segments || []) {
      const queuedSegment = {
        ...segment,
        taskId: task.id,
        priority,
        segmentDelaySeconds: Math.max(
          0,
          Number(task.segmentDelaySeconds || 0),
        ),
      };
      if (priority === "idle") {
        this.queue.push(queuedSegment);
        continue;
      }

      const firstIdleIndex = this.queue.findIndex(
        (item) => item.priority === "idle",
      );
      if (firstIdleIndex === -1) {
        this.queue.push(queuedSegment);
      } else {
        this.queue.splice(firstIdleIndex, 0, queuedSegment);
      }
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    return this.drain();
  }

  clear() {
    this.queue = [];
  }

  cancelQueued(predicate) {
    const before = this.queue.length;
    this.queue = this.queue.filter((segment) => !predicate(segment));
    return before - this.queue.length;
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.paused && this.queue.length) {
        this.current = this.queue.shift();
        const result = await this.executeSegment(this.current);
        const delaySeconds = Number(
          result?.delaySeconds ?? this.current.segmentDelaySeconds,
        );
        if (delaySeconds > 0) {
          await this.wait(delaySeconds);
        }
        this.current = null;
      }
    } finally {
      this.current = null;
      this.busy = false;
    }
  }

  status() {
    return {
      busy: this.busy,
      paused: this.paused,
      current: this.current,
      queuedSegments: this.queue.length,
      queued: structuredClone(this.queue),
    };
  }
}

function defaultWait(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
