export function buildAudioRoutes(output = {}) {
  const mode = output.mode || "system";
  if (mode === "system") {
    return [{ deviceId: "", label: "系统默认输出" }];
  }
  if (!output.primaryDeviceId) {
    throw new Error("请选择主输出设备");
  }
  const routes = [
    {
      deviceId: output.primaryDeviceId,
      label: output.primaryDeviceLabel || "主输出设备",
    },
  ];
  if (mode === "dual") {
    if (!output.monitorDeviceId) {
      throw new Error("请选择监听输出设备");
    }
    if (output.monitorDeviceId === output.primaryDeviceId) {
      throw new Error("主输出和监听输出不能选择同一个设备");
    }
    routes.push({
      deviceId: output.monitorDeviceId,
      label: output.monitorDeviceLabel || "监听输出设备",
    });
  }
  return routes;
}

export class AudioRouter {
  constructor({
    createAudio = (url) => new Audio(url),
    mediaDevices = globalThis.navigator?.mediaDevices,
  } = {}) {
    this.createAudio = createAudio;
    this.mediaDevices = mediaDevices;
    this.activeAudio = [];
  }

  async listOutputDevices({ requestPermission = false } = {}) {
    if (!this.mediaDevices?.enumerateDevices) {
      throw new Error("当前浏览器不支持读取音频输出设备");
    }
    if (requestPermission) {
      if (!this.mediaDevices.getUserMedia) {
        throw new Error("当前浏览器不支持音频设备授权");
      }
      const stream = await this.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    }
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `音频输出 ${index + 1}`,
      }));
  }

  async play(url, output) {
    this.stop();
    const routes = buildAudioRoutes(output);
    const audios = routes.map((route) => this.createAudio(url));
    const volume = Math.min(1, Math.max(0, Number(output?.volume ?? 1)));
    for (const audio of audios) audio.volume = volume;
    await Promise.all(
      audios.map(async (audio, index) => {
        const route = routes[index];
        if (!route.deviceId) return;
        if (typeof audio.setSinkId !== "function") {
          throw new Error("当前浏览器不支持选择音频输出设备");
        }
        await audio.setSinkId(route.deviceId);
      }),
    );
    await Promise.all(audios.map((audio) => audio.play()));
    this.activeAudio = audios;
    return { outputs: routes, audios };
  }

  stop() {
    for (const audio of this.activeAudio) {
      audio.pause?.();
    }
    this.activeAudio = [];
  }
}
