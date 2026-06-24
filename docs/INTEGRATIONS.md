# 集成说明

## 腾讯云联网搜索 MCP

在腾讯云创建联网搜索 MCP 服务后，把 SSE / Streamable HTTP endpoint 填入控制台的“联网搜索 MCP”。API 凭据只保存本机。雪风在需要实时信息时可搜索，结果先进入短期记忆；天气、价格、新闻等时效信息默认不会自动成为长期记忆。

## BiliNCM

本项目不打包 BiliNCM。请从其官方仓库单独安装并登录。桥接工具只读取其本机 loopback API 的点歌状态和日志，不复制 Cookie、账号或点歌规则。

## VoiceMeeter

VoiceMeeter 也是可选的独立软件。桥接工具通过其远程接口设置一个共享输入条的 A1/B1 路由，实现：

- `stream_only`：仅送直播。
- `stream_and_media`：同时送直播与本地媒体。
- `media_only`：仅本地媒体。

先在 VoiceMeeter 中确认硬件输出和虚拟输入，再在控制台启用路由。外部程序未运行时，音乐模块会报状态错误但不影响 AI、字幕和 TTS。
