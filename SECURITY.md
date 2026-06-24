# Security Policy

## Do not commit private data

Never commit any of the following:

- AI API keys, Tencent Cloud credentials, MCP endpoint tokens, or `.env` files.
- Bilibili cookies, browser profiles, QR-login data, SESSDATA, bili_jct, or room-owner information.
- `%APPDATA%\YukikazeDialogueBridge\` contents, including `config.json`, `secrets.json`, and `ai-memory.sqlite`.
- GPT-SoVITS model weights, reference audio, generated audio, training datasets, or private screenshots.

The supplied `.gitignore` covers common local files, but review `git status` before every commit.

## Reporting a vulnerability

Do not publish exploitable details or credentials in a public issue. Open a private contact channel with the maintainer first, include reproduction steps with secrets removed, and allow time for a fix before disclosure.
