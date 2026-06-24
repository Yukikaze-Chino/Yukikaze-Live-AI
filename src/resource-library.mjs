import fs from "node:fs";
import path from "node:path";

const RESOURCE_TYPES = Object.freeze({
  gpt: {
    directoryKey: "gptDirectory",
    extensions: new Set([".ckpt"]),
  },
  sovits: {
    directoryKey: "sovitsDirectory",
    extensions: new Set([".pth"]),
  },
  reference: {
    directoryKey: "referenceDirectory",
    extensions: new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"]),
  },
});

export function resolveResourcePaths(root) {
  return {
    root,
    referenceDirectory: path.join(root, "参考音频"),
    gptDirectory: path.join(root, "GPT模型"),
    sovitsDirectory: path.join(root, "SoVITS模型"),
    metadataPath: path.join(root, "参考音频", "metadata.json"),
  };
}

export function uniqueDestinationName(existingNames, requestedName) {
  const existing = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!existing.has(requestedName.toLowerCase())) return requestedName;

  const extension = path.extname(requestedName);
  const baseName = path.basename(requestedName, extension);
  let index = 2;
  while (
    existing.has(`${baseName} (${index})${extension}`.toLowerCase())
  ) {
    index += 1;
  }
  return `${baseName} (${index})${extension}`;
}

function copyIfMissing(sourcePath, destinationPath) {
  if (fs.existsSync(destinationPath)) return destinationPath;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`找不到推荐资源：${sourcePath}`);
  }
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function initializeOptionalResource(sourcePath, destinationDirectory) {
  const source = String(sourcePath || "").trim();
  if (!source) return "";
  return copyIfMissing(source, path.join(destinationDirectory, path.basename(source)));
}

function normalizeComparablePath(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function safeFileName(fileName) {
  const name = String(fileName || "").trim();
  if (
    !name ||
    name !== path.basename(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error("无效的资源文件名");
  }
  return name;
}

function resourceDefinition(type) {
  const definition = RESOURCE_TYPES[type];
  if (!definition) throw new Error(`不支持的资源类型：${type}`);
  return definition;
}

export class ResourceLibrary {
  constructor({ resourceRoot }) {
    this.paths = resolveResourcePaths(resourceRoot);
  }

  initialize({ defaults = {} } = {}) {
    fs.mkdirSync(this.paths.referenceDirectory, { recursive: true });
    fs.mkdirSync(this.paths.gptDirectory, { recursive: true });
    fs.mkdirSync(this.paths.sovitsDirectory, { recursive: true });

    return {
      gptWeightsPath: initializeOptionalResource(
        defaults.gpt,
        this.paths.gptDirectory,
      ),
      sovitsWeightsPath: initializeOptionalResource(
        defaults.sovits,
        this.paths.sovitsDirectory,
      ),
      refAudioPath: initializeOptionalResource(
        defaults.reference,
        this.paths.referenceDirectory,
      ),
    };
  }

  listResources(config) {
    return {
      gpt: this.#listType("gpt", config.tts.gptWeightsPath),
      sovits: this.#listType("sovits", config.tts.sovitsWeightsPath),
      references: this.#listType("reference", config.tts.refAudioPath),
    };
  }

  isManagedResource(type, filePath) {
    const definition = resourceDefinition(type);
    if (!filePath || !fs.existsSync(filePath)) return false;
    const resolvedPath = path.resolve(filePath);
    const directory = path.resolve(this.paths[definition.directoryKey]);
    return (
      path.dirname(resolvedPath).toLowerCase() === directory.toLowerCase() &&
      definition.extensions.has(path.extname(resolvedPath).toLowerCase()) &&
      fs.statSync(resolvedPath).isFile()
    );
  }

  resolveReference(fileName) {
    let safeName;
    try {
      safeName = safeFileName(fileName);
    } catch {
      throw new Error("无效的参考音频文件名");
    }
    const filePath = path.join(this.paths.referenceDirectory, safeName);
    if (
      path.dirname(path.resolve(filePath)) !==
      path.resolve(this.paths.referenceDirectory)
    ) {
      throw new Error("无效的参考音频文件名");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`找不到参考音频：${safeName}`);
    }
    return filePath;
  }

  createImportStream({ type, fileName }) {
    const definition = resourceDefinition(type);
    const safeName = safeFileName(fileName);
    const extension = path.extname(safeName).toLowerCase();
    if (!definition.extensions.has(extension)) {
      throw new Error(`不支持的${type}文件扩展名：${extension || "无"}`);
    }

    const directory = this.paths[definition.directoryKey];
    fs.mkdirSync(directory, { recursive: true });
    const existingNames = fs.readdirSync(directory);
    const destinationName = uniqueDestinationName(existingNames, safeName);
    const destinationPath = path.join(directory, destinationName);
    const temporaryPath = `${destinationPath}.${crypto.randomUUID()}.tmp`;
    const writeStream = fs.createWriteStream(temporaryPath, { flags: "wx" });
    let settled = false;

    const completed = new Promise((resolve, reject) => {
      writeStream.once("finish", () => {
        try {
          fs.renameSync(temporaryPath, destinationPath);
          settled = true;
          resolve({
            type,
            name: destinationName,
            path: destinationPath,
          });
        } catch (error) {
          reject(error);
        }
      });
      writeStream.once("error", (error) => {
        reject(error);
      });
    }).finally(() => {
      if (!settled && fs.existsSync(temporaryPath)) {
        fs.rmSync(temporaryPath, { force: true });
      }
    });

    return { writeStream, completed, destinationPath, temporaryPath };
  }

  #listType(type, selectedPath) {
    const definition = resourceDefinition(type);
    const directory = this.paths[definition.directoryKey];
    fs.mkdirSync(directory, { recursive: true });
    const selected = selectedPath
      ? normalizeComparablePath(selectedPath)
      : "";

    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          definition.extensions.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        const stat = fs.statSync(filePath);
        return {
          name: entry.name,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          selected: normalizeComparablePath(filePath) === selected,
        };
      })
      .sort((left, right) =>
        right.modifiedAt.localeCompare(left.modifiedAt),
      );
  }
}
