# 测试与发布检查

## 自动化测试

```powershell
npm test
git diff --check
npm audit --omit=dev --json
```

测试覆盖回复队列、TTS 请求、B 站事件规范化、上下文与记忆、网页聊天镜像、MCP 搜索、台词输出、公开版构建，以及浏览器源状态。

## 直播前手动检查

1. 使用离线测试聊天确认 AI 返回文字。
2. 确认白框显示的句子与正在播放的 TTS 句子一致。
3. 检查 `/caption`、`/dialogue`、`/log-overlay` 三个浏览器源。
4. 检查真实弹幕发送开关仍按预期关闭或开启。
5. 开播后再验证进房、关注、礼物和点歌事件。

## 公开发布检查

公开副本由维护工作区的发布脚本生成，因此不包含打包脚本本身。创建远程仓库前，先在公开目录运行：

```powershell
git status --short
git diff --check
```

确认没有密钥、Cookie、账号、房间号、模型、音频、截图隐私或本机路径后，再创建 GitHub 远程仓库。
