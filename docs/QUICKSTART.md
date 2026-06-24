# 快速开始

## 前置条件

- Windows 10/11
- Node.js 20 或更新版本
- 可选：GPT-SoVITS、本地音频设备、BiliNCM、VoiceMeeter

## 安装与启动

```powershell
npm ci
npm test
npm run dialogue-bridge
```

也可以双击 `start_dialogue_bridge.bat`。控制台地址为：

```text
http://127.0.0.1:17374/control
```

首次启动不应自动连入任何真实直播间，也不会发送真实弹幕。先在控制台的离线测试聊天中发送一条消息，确认 AI、TTS、字幕和音频输出依次正常。

## 第一次配置

1. 在“显示与发送设置”填写自己的 B 站房间 ID。
2. 在“AI 自动回复”填写 API 类型、地址、模型和 API Key。密钥仅保存在本机应用数据目录。
3. 在“TTS 模型”选择或导入自己的 GPT-SoVITS 模型与参考音频。
4. 在“音频输出”选择直播、媒体或双设备输出。
5. 确认字幕浏览器源和音频播放器均能工作后，再开启真实 B 站弹幕发送。

配置文件示例见仓库根目录的 [`config.example.json`](../config.example.json)。实际配置由程序保存在 `%APPDATA%\YukikazeLiveAI\config.json`，不应提交。
