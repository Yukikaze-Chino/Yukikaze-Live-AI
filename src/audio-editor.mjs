import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { uniqueDestinationName } from "./resource-library.mjs";

export function validateTrimRange(startSeconds, endSeconds) {
  const start = Number(startSeconds);
  const end = Number(endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    return { ok: false, message: "裁剪时间无效" };
  }
  if (end <= start) {
    return { ok: false, message: "结束时间必须晚于开始时间" };
  }
  const durationSeconds = end - start;
  if (durationSeconds < 3) {
    return { ok: false, message: "选区必须至少 3 秒", durationSeconds };
  }
  if (durationSeconds > 10) {
    return { ok: false, message: "选区不能超过 10 秒", durationSeconds };
  }
  return { ok: true, message: "选区时长有效", durationSeconds };
}

export function buildTrimmedFileName(sourceName, startSeconds, endSeconds) {
  const extension = path.extname(sourceName);
  const baseName = path.basename(sourceName, extension);
  return `${baseName}_${Number(startSeconds).toFixed(2)}-${Number(
    endSeconds,
  ).toFixed(2)}.wav`;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`无法读取参考音频元数据：${error.message}`);
  }
}

export class AudioEditor {
  constructor({ library, gptSoVitsRoot }) {
    this.library = library;
    this.gptSoVitsRoot = gptSoVitsRoot;
  }

  probeAudio(filePath) {
    const ffprobePath = path.join(
      this.gptSoVitsRoot,
      "runtime",
      "ffprobe.exe",
    );
    const result = spawnSync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=sample_rate,channels",
        "-of",
        "json",
        filePath,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`无法读取音频：${result.stderr || filePath}`);
    }
    const data = JSON.parse(result.stdout);
    const audioStream =
      data.streams?.find((stream) => stream.sample_rate) || data.streams?.[0];
    return {
      durationSeconds: Number(data.format?.duration),
      sampleRate: Number(audioStream?.sample_rate || 0),
      channels: Number(audioStream?.channels || 0),
      formatName: String(data.format?.format_name || ""),
    };
  }

  trim({
    sourceName,
    startSeconds,
    endSeconds,
    promptText,
    promptLang,
  }) {
    const validation = validateTrimRange(startSeconds, endSeconds);
    if (!validation.ok) throw new Error(validation.message);
    const sourcePath = this.library.resolveReference(sourceName);
    const sourceMetadata = this.probeAudio(sourcePath);
    if (Number(endSeconds) > sourceMetadata.durationSeconds + 0.001) {
      throw new Error("裁剪结束时间超过原始音频长度");
    }

    const requestedName = buildTrimmedFileName(
      sourceName,
      startSeconds,
      endSeconds,
    );
    const existingNames = fs.readdirSync(
      this.library.paths.referenceDirectory,
    );
    const outputName = uniqueDestinationName(existingNames, requestedName);
    const outputPath = path.join(
      this.library.paths.referenceDirectory,
      outputName,
    );
    const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp.wav`;
    const ffmpegPath = path.join(
      this.gptSoVitsRoot,
      "runtime",
      "ffmpeg.exe",
    );
    const result = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-ss",
        String(startSeconds),
        "-to",
        String(endSeconds),
        "-i",
        sourcePath,
        "-ar",
        "32000",
        "-ac",
        "1",
        temporaryPath,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0 || !fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
      throw new Error(`裁剪音频失败：${result.stderr}`);
    }
    fs.renameSync(temporaryPath, outputPath);

    const outputMetadata = this.probeAudio(outputPath);
    this.saveMetadata(outputName, {
      promptText: String(promptText || ""),
      promptLang: String(promptLang || ""),
      sourceName,
      trimStart: Number(startSeconds),
      trimEnd: Number(endSeconds),
      durationSeconds: outputMetadata.durationSeconds,
    });
    return {
      name: outputName,
      path: outputPath,
      metadata: this.getMetadata(outputName),
      audio: outputMetadata,
    };
  }

  getMetadata(fileName) {
    return readJsonFile(this.library.paths.metadataPath)[fileName] || null;
  }

  saveMetadata(fileName, metadata) {
    const safePath = this.library.resolveReference(fileName);
    if (!safePath) throw new Error(`找不到参考音频：${fileName}`);
    const current = readJsonFile(this.library.paths.metadataPath);
    current[fileName] = {
      promptText: String(metadata.promptText || ""),
      promptLang: String(metadata.promptLang || ""),
      sourceName: String(metadata.sourceName || fileName),
      trimStart: Number(metadata.trimStart || 0),
      trimEnd: Number(metadata.trimEnd || metadata.durationSeconds || 0),
      durationSeconds: Number(metadata.durationSeconds || 0),
    };
    const temporaryPath = `${this.library.paths.metadataPath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(current, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(temporaryPath, this.library.paths.metadataPath);
    return current[fileName];
  }
}
