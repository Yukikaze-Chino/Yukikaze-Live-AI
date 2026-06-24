import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tools",
  "voicemeeter-remote.ps1",
);

const ROUTES = Object.freeze({
  stream_only: Object.freeze({ A1: 0, B1: 1 }),
  stream_and_media: Object.freeze({ A1: 1, B1: 1 }),
  media_only: Object.freeze({ A1: 1, B1: 0 }),
});

const INPUT_STRIP_PATTERN = /^Strip\[\d+\]$/;

export function resolveVoiceMeeterRoute(mode) {
  const route = ROUTES[mode];
  if (!route) {
    throw new Error("未知音频输出模式");
  }
  return { ...route };
}

export async function runVoiceMeeterHelper({
  action,
  mode = "stream_and_media",
  remoteDllPath = "",
  inputStrip = "Strip[0]",
} = {}) {
  if (!["status", "apply"].includes(action)) {
    throw new Error("不支持的 VoiceMeeter 操作");
  }
  if (action === "apply") {
    resolveVoiceMeeterRoute(mode);
  }
  if (!INPUT_STRIP_PATTERN.test(inputStrip)) {
    throw new Error("VoiceMeeter 输入条必须是 Strip[n] 格式");
  }

  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    HELPER_PATH,
    "-Action",
    action,
    "-Mode",
    mode,
    "-DllPath",
    String(remoteDllPath || "").trim(),
    "-InputStrip",
    inputStrip,
  ];

  try {
    const { stdout } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 64 * 1024,
    });
    return parseHelperResult(stdout, inputStrip);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "未知错误").trim();
    return disconnectedVoiceMeeterState(detail || "VoiceMeeter 辅助程序未响应。", inputStrip);
  }
}

export class VoiceMeeterRouter {
  constructor({ runHelper = runVoiceMeeterHelper } = {}) {
    this.runHelper = runHelper;
  }

  async status({ remoteDllPath = "", inputStrip = "Strip[0]" } = {}) {
    return this.runHelper({
      action: "status",
      remoteDllPath,
      inputStrip,
    });
  }

  async apply({
    mode,
    remoteDllPath = "",
    inputStrip = "Strip[0]",
  } = {}) {
    const expected = resolveVoiceMeeterRoute(mode);
    const result = await this.runHelper({
      action: "apply",
      mode,
      remoteDllPath,
      inputStrip,
    });
    if (
      !result?.ok
      || Number(result.A1) !== expected.A1
      || Number(result.B1) !== expected.B1
    ) {
      throw new Error("VoiceMeeter 未确认应用输出模式。");
    }
    return { ...result, mode };
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseHelperResult(stdout, inputStrip) {
  const output = String(stdout || "").trim();
  if (!output) {
    return disconnectedVoiceMeeterState("VoiceMeeter 辅助程序没有返回状态。", inputStrip);
  }
  try {
    const result = JSON.parse(output);
    return {
      ok: Boolean(result?.ok),
      A1: Number(result?.A1) === 1 ? 1 : 0,
      B1: Number(result?.B1) === 1 ? 1 : 0,
      inputStrip: String(result?.inputStrip || inputStrip),
      error: String(result?.error || ""),
    };
  } catch {
    return disconnectedVoiceMeeterState("VoiceMeeter 辅助程序返回了无效状态。", inputStrip);
  }
}

function disconnectedVoiceMeeterState(error, inputStrip) {
  return {
    ok: false,
    A1: 0,
    B1: 0,
    inputStrip,
    error: String(error || "VoiceMeeter 不可用。"),
  };
}
