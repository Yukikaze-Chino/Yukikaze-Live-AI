import fs from "node:fs";
import path from "node:path";

export class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return {};
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  getAiApiKey() {
    return String(this.read().aiApiKey || "");
  }

  setAiApiKey(value) {
    const data = this.read();
    const aiApiKey = String(value || "").trim();
    if (aiApiKey) {
      data.aiApiKey = aiApiKey;
    } else {
      delete data.aiApiKey;
    }
    this.write(data);
  }

  getTencentCloudCredentials() {
    const data = this.read();
    return {
      secretId: String(data.tencentCloudSecretId || ""),
      secretKey: String(data.tencentCloudSecretKey || ""),
    };
  }

  setTencentCloudCredentials({ secretId = "", secretKey = "" } = {}) {
    const data = this.read();
    const normalizedSecretId = String(secretId || "").trim();
    const normalizedSecretKey = String(secretKey || "").trim();
    if (normalizedSecretId) {
      data.tencentCloudSecretId = normalizedSecretId;
    } else {
      delete data.tencentCloudSecretId;
    }
    if (normalizedSecretKey) {
      data.tencentCloudSecretKey = normalizedSecretKey;
    } else {
      delete data.tencentCloudSecretKey;
    }
    this.write(data);
  }

  status() {
    const tencent = this.getTencentCloudCredentials();
    return {
      hasAiApiKey: Boolean(this.getAiApiKey()),
      hasTencentCloudCredentials: Boolean(
        tencent.secretId && tencent.secretKey,
      ),
    };
  }
}
