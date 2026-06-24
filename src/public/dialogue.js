const stage = document.querySelector("#stage");
const dialogueLogNode = document.querySelector("#snowkazeDialogueLog");
let lastSignature = "";

function scaleStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `scale(${scale})`;
}

function applyLayout(settings = {}) {
  const itemMinHeight = Math.max(1, Math.trunc(Number(settings.itemMinHeight || 48)));
  dialogueLogNode.style.left = `${Number(settings.x || 0)}px`;
  dialogueLogNode.style.top = `${Number(settings.y || 0)}px`;
  dialogueLogNode.style.width = `${Number(settings.width || 430)}px`;
  dialogueLogNode.style.height = `${Math.max(1, Math.trunc(Number(settings.height || 360)))}px`;
  dialogueLogNode.style.fontSize = `${Number(settings.fontSize || 24)}px`;
  dialogueLogNode.style.gap = `${Math.max(0, Math.trunc(Number(settings.gap || 10)))}px`;
  dialogueLogNode.style.setProperty("--dialogue-item-min-height", `${itemMinHeight}px`);
}

function render(log, speakerLabel) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const signature = JSON.stringify([speakerLabel, entries.map((entry) => [entry.id, entry.text])]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  dialogueLogNode.replaceChildren();
  if (entries.length === 0) {
    dialogueLogNode.classList.add("hidden");
    return;
  }
  for (const entry of entries) {
    const node = document.createElement("div");
    node.className = "dialogue-log-entry";
    node.textContent = `${speakerLabel || "雪风"}：${entry.text}`;
    dialogueLogNode.appendChild(node);
  }
  dialogueLogNode.classList.remove("hidden");
}

async function poll() {
  try {
    const response = await fetch(`/api/state?t=${Date.now()}`);
    const data = await response.json();
    if (!data.ok) return;
    applyLayout(data.config.dialogueLog);
    render(data.dialogueLog, data.config.speakerLabels?.ai);
  } catch {
    // Keep this browser source transparent while the bridge restarts.
  }
}

window.addEventListener("resize", scaleStage);
scaleStage();
poll();
setInterval(poll, 250);
