import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_SCRIPT = fileURLToPath(
  new URL("./gpt_sovits_gradio_server.py", import.meta.url),
);

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

function yamlString(value) {
  return `"${normalizePath(value).replaceAll('"', '\\"')}"`;
}

function absoluteFromRoot(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function endpointBase(config) {
  return String(config.tts.gradioEndpoint || "").replace(/\/$/, "");
}

function profileFingerprint(config) {
  const tts = config.tts || {};
  return JSON.stringify({
    endpoint: endpointBase(config),
    root: String(tts.gptSoVitsRoot || ""),
    gpt: String(tts.gptWeightsPath || ""),
    sovits: String(tts.sovitsWeightsPath || ""),
  });
}

function gradioConfigHasTtsEndpoint(body) {
  const dependencies = Array.isArray(body?.dependencies)
    ? body.dependencies
    : [];
  return dependencies.some(
    (dependency) =>
      dependency?.api_name === "get_tts_wav" ||
      dependency?.api_name === "/get_tts_wav",
  );
}

async function probeEndpoint(config, timeoutMilliseconds = 2500) {
  const endpoint = endpointBase(config);
  if (!endpoint) {
    return { ok: false, message: "未配置 GPT-SoVITS 原版 Gradio 地址" };
  }

  try {
    const response = await fetch(`${endpoint}/config`, {
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `GPT-SoVITS 原版 Gradio 返回 HTTP ${response.status}`,
      };
    }
    const body = await response.json();
    if (!gradioConfigHasTtsEndpoint(body)) {
      return {
        ok: false,
        message: "该地址不是可用的 GPT-SoVITS 原版推理页面",
      };
    }
    return {
      ok: true,
      message: "GPT-SoVITS 原版 Gradio 已连接",
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export function resolveManagedTtsPaths(appDirectory) {
  return {
    ttsDirectory: path.join(appDirectory, "tts"),
    logsDirectory: path.join(appDirectory, "logs"),
    referenceAudioPath: path.join(appDirectory, "tts", "reference.mp3"),
    apiConfigPath: path.join(appDirectory, "tts", "tts_infer.yaml"),
    stdoutPath: path.join(appDirectory, "logs", "tts-gradio.stdout.log"),
    stderrPath: path.join(appDirectory, "logs", "tts-gradio.stderr.log"),
  };
}

export function validateReferenceDuration(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 3) {
    return { ok: false, message: "参考音频必须至少 3 秒" };
  }
  if (duration > 10) {
    return { ok: false, message: "参考音频不能超过 10 秒" };
  }
  return { ok: true, message: "参考音频时长有效" };
}

function referenceDuration(root, filePath) {
  const ffprobePath = path.join(root, "runtime", "ffprobe.exe");
  if (!fs.existsSync(ffprobePath)) {
    throw new Error(`找不到 ffprobe：${ffprobePath}`);
  }
  const result = spawnSync(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const duration = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration)) {
    throw new Error(
      `无法读取参考音频时长：${result.stderr || filePath}`,
    );
  }
  return duration;
}

// Kept for backward-compatible tests and old configuration exports.
export function buildApiConfigYaml(config) {
  const root = config.tts.gptSoVitsRoot;
  const bertPath = absoluteFromRoot(
    root,
    "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
  );
  const hubertPath = absoluteFromRoot(
    root,
    "GPT_SoVITS/pretrained_models/chinese-hubert-base",
  );
  const gptWeightsPath = absoluteFromRoot(root, config.tts.gptWeightsPath);
  const sovitsWeightsPath = absoluteFromRoot(
    root,
    config.tts.sovitsWeightsPath,
  );

  return [
    "custom:",
    `  bert_base_path: ${yamlString(bertPath)}`,
    `  cnhuhbert_base_path: ${yamlString(hubertPath)}`,
    "  device: cuda",
    "  is_half: true",
    `  t2s_weights_path: ${yamlString(gptWeightsPath)}`,
    `  vits_weights_path: ${yamlString(sovitsWeightsPath)}`,
    "  version: v2Pro",
    "",
  ].join("\n");
}

export function buildGradioLaunchEnvironment(config) {
  const root = config.tts.gptSoVitsRoot;
  const endpoint = new URL(config.tts.gradioEndpoint);
  return {
    gpt_path: absoluteFromRoot(root, config.tts.gptWeightsPath),
    sovits_path: absoluteFromRoot(root, config.tts.sovitsWeightsPath),
    version: "v2Pro",
    infer_ttswebui: endpoint.port || "9872",
    language: "zh_CN",
    is_share: "False",
    is_half: "True",
    cnhubert_base_path: absoluteFromRoot(
      root,
      "GPT_SoVITS/pretrained_models/chinese-hubert-base",
    ),
    bert_path: absoluteFromRoot(
      root,
      "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
    ),
  };
}

export class TtsManager {
  constructor({
    appDirectory,
    serverScriptPath = DEFAULT_SERVER_SCRIPT,
  }) {
    this.paths = resolveManagedTtsPaths(appDirectory);
    this.serverScriptPath = serverScriptPath;
    this.child = null;
    this.starting = false;
    this.lastError = "";
    this.activeProfileFingerprint = "";
  }

  async prepare(config) {
    const root = config.tts.gptSoVitsRoot;
    const inferenceScriptPath = path.join(
      root,
      "GPT_SoVITS",
      "inference_webui.py",
    );
    const sourceReferencePath = config.tts.refAudioPath;
    const gptWeightsPath = absoluteFromRoot(root, config.tts.gptWeightsPath);
    const sovitsWeightsPath = absoluteFromRoot(
      root,
      config.tts.sovitsWeightsPath,
    );

    for (const [label, filePath] of [
      ["GPT-SoVITS Python", config.tts.pythonPath],
      ["GPT-SoVITS 原版推理程序", inferenceScriptPath],
      ["Gradio 隐藏启动器", this.serverScriptPath],
      ["参考音频", sourceReferencePath],
      ["GPT 模型", gptWeightsPath],
      ["SoVITS 模型", sovitsWeightsPath],
    ]) {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`${label}不存在：${filePath || "未配置"}`);
      }
    }

    fs.mkdirSync(this.paths.ttsDirectory, { recursive: true });
    fs.mkdirSync(this.paths.logsDirectory, { recursive: true });

    const duration = referenceDuration(root, sourceReferencePath);
    const durationValidation = validateReferenceDuration(duration);
    if (!durationValidation.ok) {
      throw new Error(
        `${durationValidation.message}，当前为 ${duration.toFixed(2)} 秒`,
      );
    }

    return {
      ...this.paths,
      referenceAudioPath: sourceReferencePath,
      inferenceScriptPath,
      serverScriptPath: this.serverScriptPath,
      gptWeightsPath,
      sovitsWeightsPath,
    };
  }

  async status(config) {
    const probe = await probeEndpoint(config);
    const owned = Boolean(this.child && this.child.exitCode === null);
    return {
      ...probe,
      backend: "native-gradio",
      running: probe.ok,
      starting: this.starting,
      owned,
      pid: owned ? this.child.pid : null,
      message: this.starting
        ? "GPT-SoVITS 原版 Gradio 正在启动"
        : probe.message,
      lastError: this.lastError,
      logs: {
        stdout: this.paths.stdoutPath,
        stderr: this.paths.stderrPath,
      },
    };
  }

  async ensureReady(config) {
    const requestedFingerprint = profileFingerprint(config);
    const probe = await probeEndpoint(config);
    if (probe.ok) {
      if (
        this.activeProfileFingerprint &&
        this.activeProfileFingerprint !== requestedFingerprint
      ) {
        return this.restart(config);
      }
      this.activeProfileFingerprint = requestedFingerprint;
      return this.status(config);
    }
    if (!config.tts.autoStartApi) {
      throw new Error(
        `GPT-SoVITS 原版 Gradio 未运行：${probe.message}。请在控制页点击“启动 TTS”。`,
      );
    }
    return this.start(config);
  }

  async start(config) {
    if (this.starting) {
      throw new Error("GPT-SoVITS 原版 Gradio 正在启动，请稍候");
    }

    const existing = await probeEndpoint(config);
    if (existing.ok) {
      this.activeProfileFingerprint = profileFingerprint(config);
      return this.status(config);
    }

    this.starting = true;
    this.lastError = "";
    let stdoutFd;
    let stderrFd;
    let childWasCreated = false;

    try {
      const prepared = await this.prepare(config);
      const endpoint = new URL(config.tts.gradioEndpoint);
      const host = endpoint.hostname || "127.0.0.1";
      const port = endpoint.port || "9872";

      stdoutFd = fs.openSync(this.paths.stdoutPath, "a");
      stderrFd = fs.openSync(this.paths.stderrPath, "a");
      this.child = spawn(
        config.tts.pythonPath,
        [
          prepared.serverScriptPath,
          "--root",
          config.tts.gptSoVitsRoot,
          "--host",
          host,
          "--port",
          port,
        ],
        {
          cwd: config.tts.gptSoVitsRoot,
          env: {
            ...process.env,
            ...buildGradioLaunchEnvironment(config),
            PYTHONIOENCODING: "utf-8",
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          stdio: ["ignore", stdoutFd, stderrFd],
          windowsHide: true,
        },
      );
      childWasCreated = true;

      this.child.once("exit", (code) => {
        if (code && !this.lastError) {
          this.lastError = `GPT-SoVITS 原版 Gradio 已退出，代码 ${code}`;
        }
        this.child = null;
        if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
        if (stderrFd !== undefined) fs.closeSync(stderrFd);
      });
      this.child.once("error", (error) => {
        this.lastError = error.message;
      });

      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (!this.child || this.child.exitCode !== null) {
          throw new Error(
            this.lastError ||
              `GPT-SoVITS 原版 Gradio 启动失败，请查看 ${this.paths.stderrPath}`,
          );
        }
        const probe = await probeEndpoint(config, 2000);
        if (probe.ok) {
          this.activeProfileFingerprint = profileFingerprint(config);
          return this.status(config);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      throw new Error(
        `GPT-SoVITS 原版 Gradio 启动超时，请查看 ${this.paths.stderrPath}`,
      );
    } catch (error) {
      this.lastError = error.message;
      if (this.child && this.child.exitCode === null) {
        this.#killOwnedProcess();
      } else if (!childWasCreated) {
        if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
        if (stderrFd !== undefined) fs.closeSync(stderrFd);
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async restart(config) {
    await this.stop(config);
    return this.start(config);
  }

  async stop(config) {
    const probe = await probeEndpoint(config);
    if (!this.child || this.child.exitCode !== null) {
      if (probe.ok) {
        throw new Error(
          "当前原版 Gradio 不是由台词工具启动的，为避免误关其他程序，请手动关闭它。",
        );
      }
      this.activeProfileFingerprint = "";
      return this.status(config);
    }

    this.#killOwnedProcess();
    const deadline = Date.now() + 15_000;
    while (this.child && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.activeProfileFingerprint = "";
    return this.status(config);
  }

  shutdown() {
    if (this.child && this.child.exitCode === null) this.#killOwnedProcess();
    this.activeProfileFingerprint = "";
  }

  #killOwnedProcess() {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      this.child.kill("SIGTERM");
    }
  }
}
