import { AudioRouter } from "/public/audio-router.js";
import { AudioPlaybackController } from "/public/audio-playback-controller.js";

const statusNode = document.querySelector("#audioPlayerStatus");
const outputNode = document.querySelector("#audioPlayerOutput");
const lineNode = document.querySelector("#audioPlayerLine");
const unlockButton = document.querySelector("#unlockAudioButton");
const controller = new AudioPlaybackController({
  audioRouter: new AudioRouter(),
  onState({ status, output, line }) {
    if (status) statusNode.textContent = status;
    if (output) outputNode.textContent = output;
    if (line) lineNode.textContent = line;
  },
});

unlockButton.addEventListener("click", async () => {
  try {
    await controller.unlock(controller.latestConfig, {
      testAudioUrl: "/api/audio/test-tone",
    });
  } catch {
    // The controller already renders the concrete failure message.
  }
});

controller.start();
