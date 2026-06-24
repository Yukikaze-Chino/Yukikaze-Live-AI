export class BiliSender {
  constructor() {
    this.context = null;
    this.page = null;
    this.lastError = "";
  }

  async ensurePage(config) {
    if (!this.context) {
      let chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (error) {
        throw new Error(
          `缺少 Playwright 依赖，请先运行 npm install。原始错误: ${error.message}`,
        );
      }

      this.context = await chromium.launchPersistentContext(
        config.browser.userDataDir,
        {
          executablePath: config.browser.edgePath,
          headless: Boolean(config.browser.headless),
          viewport: { width: 1280, height: 900 },
          args: ["--window-size=1280,900"],
        },
      );
    }

    this.page =
      this.page && !this.page.isClosed()
        ? this.page
        : this.context.pages()[0] || (await this.context.newPage());

    const targetUrl = config.browser.roomUrl || `https://live.bilibili.com/${config.roomId}`;
    if (!this.page.url().startsWith("https://live.bilibili.com/")) {
      try {
        await this.page.goto(targetUrl, { waitUntil: "commit", timeout: 30000 });
      } catch (error) {
        if (!this.page.url().startsWith("https://live.bilibili.com/")) {
          throw error;
        }
      }
    }
    return this.page;
  }

  async openForLogin(config) {
    const page = await this.ensurePage(config);
    await page.bringToFront();
    return { ok: true, url: page.url() };
  }

  async send(text, config) {
    if (!text) return { ok: true, skipped: true };
    try {
      const page = await this.ensurePage(config);
      const selectors = [
        ".chat-input-ctnr textarea",
        ".chat-input textarea",
        "textarea",
        "[contenteditable='true']",
        "input[type='text']",
      ];
      let target = null;
      for (const selector of selectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            target = candidate;
            break;
          }
        }
        if (target) break;
      }
      if (!target) {
        throw new Error(
          "没有找到直播间弹幕输入框，请确认专用网页已登录并打开直播间。",
        );
      }

      await target.fill(text);
      const sendButtons = page.getByRole("button", { name: /发送/ });
      let sent;
      if (
        (await sendButtons.count()) > 0 &&
        (await sendButtons.first().isVisible().catch(() => false))
      ) {
        await sendButtons.first().click();
        sent = { ok: true, method: "button" };
      } else {
        await target.press("Enter");
        sent = { ok: true, method: "enter" };
      }

      this.lastError = "";
      return sent;
    } catch (error) {
      this.lastError = error.message;
      return { ok: false, error: error.message };
    }
  }

  status() {
    return {
      connected: Boolean(this.context && this.page && !this.page.isClosed()),
      lastError: this.lastError,
      url: this.page && !this.page.isClosed() ? this.page.url() : "",
    };
  }
}
