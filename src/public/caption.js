import { fitFontSize } from "/public/caption-layout.js";

const stage = document.querySelector("#stage");
const layer = document.querySelector("#captionLayer");
const image = document.querySelector("#captionImage");
const textNode = document.querySelector("#captionText");
const speakerLabelNode = document.querySelector("#captionSpeakerLabel");

let lastId = -1;
let activeTimer = null;
let typingTimer = null;
let activeTextBox = null;

function scaleStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `scale(${scale})`;
}

function clearTimers() {
  if (activeTimer) clearTimeout(activeTimer);
  if (typingTimer) clearTimeout(typingTimer);
  activeTimer = null;
  typingTimer = null;
}

function applyTextBox(textBox, speakerLabelBox = {}) {
  activeTextBox = textBox;
  textNode.style.left = `${textBox.x}px`;
  textNode.style.top = `${textBox.y}px`;
  textNode.style.width = `${textBox.width}px`;
  textNode.style.height = `${textBox.height}px`;
  textNode.style.fontSize = `${textBox.fontSize}px`;
  textNode.style.lineHeight = String(textBox.lineHeight);
  textNode.style.color = textBox.color;
  textNode.style.fontFamily = textBox.fontFamily;
  textNode.style.textAlign = textBox.textAlign;
  speakerLabelNode.style.left = `${textBox.x + Number(speakerLabelBox.offsetX || 0)}px`;
  speakerLabelNode.style.top = `${Math.max(0, textBox.y + Number(speakerLabelBox.offsetY || 0))}px`;
  speakerLabelNode.style.minWidth = `${Math.max(1, Number(speakerLabelBox.minWidth || 1))}px`;
  speakerLabelNode.style.fontSize = `${Math.max(8, Number(speakerLabelBox.fontSize || 8))}px`;
}

function fitTextToBox() {
  if (!activeTextBox) return;
  const size = fitFontSize({
    preferredSize: activeTextBox.fontSize,
    minimumSize: activeTextBox.minimumFontSize || 18,
    fitsAtSize(candidateSize) {
      textNode.style.fontSize = `${candidateSize}px`;
      return (
        textNode.scrollHeight <= textNode.clientHeight + 1 &&
        textNode.scrollWidth <= textNode.clientWidth + 1
      );
    },
  });
  textNode.style.fontSize = `${size}px`;
}

function revealInstant(text, event) {
  textNode.textContent = text;
  fitTextToBox();
  scheduleFade(event);
}

function revealTypewriter(text, event, config) {
  const chars = Array.from(text);
  let index = 0;
  const step = () => {
    textNode.textContent = chars.slice(0, index).join("");
    fitTextToBox();
    if (index >= chars.length) {
      scheduleFade(event);
      return;
    }
    index += 1;
    typingTimer = setTimeout(
      step,
      Number(config.typewriterMillisecondsPerCharacter || 55),
    );
  };
  step();
}

function scheduleFade(event) {
  if (Number(event.durationSeconds) <= 0) return;
  activeTimer = setTimeout(() => {
    layer.classList.add("hidden");
  }, Number(event.durationSeconds) * 1000);
}

function showCaption(event, config) {
  clearTimers();
  applyTextBox(event.textBox, event.speakerLabelBox);
  layer.style.transitionDuration = `${Number(event.fadeSeconds || 0)}s`;
  image.src = `/asset/caption-image?t=${Date.now()}`;

  if (!event.visible) {
    textNode.textContent = "";
    speakerLabelNode.textContent = "";
    layer.classList.add("hidden");
    return;
  }

  textNode.textContent = "";
  speakerLabelNode.textContent = event.speakerLabel || "";
  layer.classList.remove("hidden");
  if (event.animation === "instant") {
    revealInstant(event.text, event);
  } else {
    revealTypewriter(event.text, event, config);
  }
}

async function poll() {
  try {
    const response = await fetch(`/api/state?t=${Date.now()}`);
    const data = await response.json();
    if (!data.ok) return;
    if (data.caption.id !== lastId) {
      lastId = data.caption.id;
      showCaption(data.caption, data.config);
    }
  } catch {
    // Keep the browser source transparent if the local server is restarting.
  }
}

window.addEventListener("resize", scaleStage);
scaleStage();
poll();
setInterval(poll, 100);
