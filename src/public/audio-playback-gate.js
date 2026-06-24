export class AudioPlaybackGate {
  constructor() {
    this.unlocked = false;
    this.pendingEvent = null;
    this.inFlightId = null;
    this.lastHandledId = null;
  }

  receive(event) {
    if (!isPlayable(event) || event.id === this.lastHandledId) {
      return { type: "ignore" };
    }
    this.pendingEvent = { ...event };
    if (!this.unlocked) {
      return { type: "pending" };
    }
    return this.startPending();
  }

  unlock() {
    this.unlocked = true;
    return this.startPending();
  }

  startPending() {
    if (
      !this.pendingEvent ||
      this.pendingEvent.id === this.lastHandledId ||
      this.pendingEvent.id === this.inFlightId
    ) {
      return { type: "ignore" };
    }
    this.inFlightId = this.pendingEvent.id;
    return { type: "play", event: { ...this.pendingEvent } };
  }

  markCompleted(id) {
    this.markHandled(id);
  }

  markFailed(id) {
    this.markHandled(id);
  }

  markHandled(id) {
    if (id !== this.inFlightId && id !== this.pendingEvent?.id) return;
    this.lastHandledId = id;
    this.inFlightId = null;
    if (this.pendingEvent?.id === id) {
      this.pendingEvent = null;
    }
  }
}

function isPlayable(event) {
  return Boolean(
    event &&
      event.id !== undefined &&
      event.id !== null &&
      event.shouldPlay &&
      String(event.audioUrl || "").trim(),
  );
}
