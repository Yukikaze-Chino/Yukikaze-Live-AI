import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildGradioTtsArgs,
  normalizeAuxiliaryReferencePaths,
} from "./core.mjs";

const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("./gpt_sovits_gradio_helper.py", import.meta.url),
);

export class TtsClient {
  constructor({
    audioDirectory,
    manager,
    library = null,
    audioEditor = null,
    helperPath = DEFAULT_HELPER_PATH,
    helperRunner = runGradioHelper,
  }) {
    this.audioDirectory = audioDirectory;
    this.manager = manager;
    this.library = library;
    this.audioEditor = audioEditor;
    this.helperPath = helperPath;
    this.helperRunner = helperRunner;
    this.synthesisTail = Promise.resolve();
  }

  async synthesize(job, config) {
    const previous = this.synthesisTail;
    let release;
    this.synthesisTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await this.#synthesizeExclusive(job, config);
    } finally {
      release();
    }
  }

  async #synthesizeExclusive(job, config) {
    if (!fs.existsSync(config.tts.refAudioPath)) {
      throw new Error(`找不到参考音频：${config.tts.refAudioPath}`);
    }

    await this.manager.ensureReady(config);
    const auxiliaryReferences =
      this.library && this.audioEditor
        ? validateAuxiliaryReferences(config, {
            library: this.library,
            audioEditor: this.audioEditor,
          })
        : normalizeAuxiliaryReferencePaths(
            config.tts.auxRefAudioPaths,
            config.tts.refAudioPath,
          );
    const gradioConfig = {
      ...config,
      tts: {
        ...config.tts,
        auxRefAudioPaths: auxiliaryReferences,
      },
    };
    fs.mkdirSync(this.audioDirectory, { recursive: true });
    const outputPath = path.join(this.audioDirectory, `${job.id}.wav`);

    try {
      await this.helperRunner({
        pythonPath: config.tts.pythonPath,
        helperPath: this.helperPath,
        payload: {
          endpoint: String(config.tts.gradioEndpoint || "").replace(/\/$/, ""),
          args: buildGradioTtsArgs(job.text, gradioConfig),
          outputPath,
        },
      });
      if (!fs.existsSync(outputPath)) {
        throw new Error(`Gradio 未生成输出文件：${outputPath}`);
      }
      return outputPath;
    } catch (error) {
      throw new Error(`GPT-SoVITS 原版推理失败：${error.message}`);
    }
  }

  async probe(config) {
    return this.manager.status(config);
  }
}

export async function runGradioHelper({
  pythonPath,
  helperPath,
  payload,
  timeoutMilliseconds = 300000,
}) {
  await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [helperPath], {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("调用原版 Gradio 推理超时"));
    }, timeoutMilliseconds);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      const lastLine = output.split(/\r?\n/).filter(Boolean).at(-1);
      let result = null;
      try {
        result = lastLine ? JSON.parse(lastLine) : null;
      } catch {
        // Detailed process output is included in the error below.
      }
      if (code === 0 && result?.ok) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          result?.error ||
            errorOutput ||
            output ||
            `Gradio 助手退出，代码 ${code}`,
        ),
      );
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export function validateAuxiliaryReferences(
  config,
  { library, audioEditor },
) {
  const paths = normalizeAuxiliaryReferencePaths(
    config.tts.auxRefAudioPaths,
    config.tts.refAudioPath,
  );
  for (const filePath of paths) {
    if (!library.isManagedResource("reference", filePath)) {
      throw new Error(`辅助参考音频不在资源库：${filePath}`);
    }
    let audio;
    try {
      audio = audioEditor.probeAudio(filePath);
    } catch (error) {
      throw new Error(`辅助参考音频无法解码：${filePath}：${error.message}`);
    }
    if (
      !Number.isFinite(Number(audio.durationSeconds)) ||
      Number(audio.durationSeconds) <= 0
    ) {
      throw new Error(`辅助参考音频无法解码：${filePath}`);
    }
  }
  return paths;
}
