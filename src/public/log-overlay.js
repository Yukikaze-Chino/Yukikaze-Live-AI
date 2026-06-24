const stage = document.querySelector("#stage");
const musicLogNode = document.querySelector("#musicLog");
let lastSignature = "";

function scaleStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `scale(${scale})`;
}

function render(log) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const signature = JSON.stringify(entries.map((entry) => [entry.id, entry.message]));
  if (signature === lastSignature) return;
  lastSignature = signature;
  musicLogNode.replaceChildren();
  if (entries.length === 0) {
    musicLogNode.classList.add("hidden");
    return;
  }
  for (const entry of entries.slice(-8)) {
    const line = document.createElement("div");
    line.className = "music-log-entry";
    const time = document.createElement("span");
    time.className = "music-log-time";
    time.textContent = `[${entry.displayTime || new Date(entry.createdAt).toLocaleTimeString()}]`;
    if (entry.color) line.dataset.color = entry.color.toLowerCase();
    line.append(time, document.createTextNode(entry.message));
    musicLogNode.appendChild(line);
  }
  musicLogNode.classList.remove("hidden");
  musicLogNode.scrollTop = musicLogNode.scrollHeight;
}

async function poll() {
  try {
    const response = await fetch(`/api/music/log?t=${Date.now()}`);
    const data = await response.json();
    if (data.ok) render(data.musicLog);
  } catch {
    // Keep this browser source transparent while BiliNCM or the bridge restarts.
  }
}

window.addEventListener("resize", scaleStage);
scaleStage();
poll();
setInterval(poll, 2000);
