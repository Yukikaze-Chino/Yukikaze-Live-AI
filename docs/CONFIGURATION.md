# 配置说明

## 本机数据位置

| 内容 | 默认位置 | 是否应提交 |
| --- | --- | --- |
| 控制台配置 | `%APPDATA%\YukikazeLiveAI\config.json` | 否 |
| API 密钥 | `%APPDATA%\YukikazeLiveAI\secrets.json` | 否 |
| 记忆数据库 | `%APPDATA%\YukikazeLiveAI\ai-memory.sqlite` | 否 |
| 生成音频与日志 | `%APPDATA%\YukikazeLiveAI\` | 否 |

## AI

控制台支持 OpenAI 兼容接口和 Claude / Anthropic 接口。选择接口类型后填写对应地址、模型和 API Key。API Key 不会回显，也不应放进角色设定、截图、日志或 Git 提交。

## TTS

人工台词和 AI 台词可使用不同的 TTS 配置。公开版默认使用 `D:\2-2-Other\GPT-SoVITS` 作为建议安装位置，但没有内置模型、权重或参考音频。请在控制台选择自己的文件。

## B 站发送

人工台词与 AI 回复的真实弹幕发送开关独立保存，默认关闭。发送与网页聊天镜像依赖本机浏览器页面；保持它运行或最小化即可，不要关闭。

## 浏览器源

| 用途 | 地址 |
| --- | --- |
| 当前台词白框 | `http://127.0.0.1:17374/caption` |
| 雪风最近发言 | `http://127.0.0.1:17374/dialogue` |
| BiliNCM 点歌日志 | `http://127.0.0.1:17374/log-overlay` |

这些页面仅在本机监听。直播姬添加浏览器源时，按自己的布局设置尺寸和透明度。
