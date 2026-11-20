const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");
const { version } = require("../package.json");
const tauriConfig = require("../src-tauri/tauri.conf.json");
const macosConfig = require("../src-tauri/tauri.macos.conf.json");

const minimumViewport = { width: 867, height: 600 };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function debugEndpoint(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 500 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode === 200) resolve(JSON.parse(body));
          else
            reject(new Error(`WebView2 DevTools HTTP ${response.statusCode}`));
        });
      },
    );
    request.once("error", reject);
    request.once("timeout", () =>
      request.destroy(new Error("DevTools timeout")),
    );
  });
}

async function main() {
  const executable = path.resolve(
    process.argv[2] || "src-tauri/target/release/solunaremote.exe",
  );
  const address = process.argv[3] || "172.22.98.13";
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "solunaremote-tauri-smoke-"),
  );
  const port = await freePort();
  const launcher = spawn(executable, [], {
    env: {
      ...process.env,
      APPDATA: path.join(profile, "appdata"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview"),
    },
    stdio: "ignore",
  });
  const launcherExit = new Promise((resolve) =>
    launcher.once("close", resolve),
  );
  let browser;
  let page;
  const errors = [];
  let appState;
  let vmDevice;
  try {
    let endpoint;
    const deadline = Date.now() + 45000;
    while (!endpoint && Date.now() < deadline) {
      if (launcher.exitCode !== null)
        throw new Error(
          `Tauri exited before WebView2 startup: ${launcher.exitCode}`,
        );
      try {
        endpoint = await debugEndpoint(port);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.ok(
      endpoint,
      "Tauri WebView2 did not expose its isolated test endpoint.",
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 10000,
    });
    const context = browser.contexts()[0];
    page = context.pages()[0] || (await context.waitForEvent("page"));
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      await page.waitForFunction(
        () => typeof window.lan?.call === "function",
        null,
        { timeout: 15000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        tauriKeys: Object.keys(window.__TAURI__ ?? {}),
        coreKeys: Object.keys(window.__TAURI__?.core ?? {}),
        eventKeys: Object.keys(window.__TAURI__?.event ?? {}),
        windowKeys: Object.keys(window.__TAURI__?.window ?? {}),
        lanType: typeof window.lan,
        readyType: typeof window.__lanBridgeReady,
        scripts: [...document.scripts].map((script) => script.src),
        content: document.querySelector("#content")?.innerText,
        errors,
      }));
      throw new Error(
        `${error.message}\nTauri page diagnostics: ${JSON.stringify(diagnostics)}`,
      );
    }
    await expect(page).toHaveTitle("SolunaRemote");
    appState = await page.evaluate(() => window.lan.call("state"));
    assert.equal(appState.version, version);
    assert.equal(appState.engines.nativeAvailable, true);
    assert.equal(appState.host.available, true);
    await expect(page.getByRole("heading", { name: "远程协助" })).toBeVisible();
    await expect(page.locator("#breadcrumb")).toHaveText("远程协助");
    await expect(page.locator("#content .page-heading")).toHaveCount(0);
    await expect(page.locator(".statusbar-notice")).toHaveText(
      "当前为本地版：连接只走局域网，不使用账号、云端中转或公网服务。",
    );
    await expect(page.locator("#content")).not.toContainText("当前为本地版");
    await expect(page.locator(".statusbar")).not.toContainText("客户端无");
    await expect(page.locator("#statusbar-text")).toBeEmpty();
    await expect(page.getByText("我的设备", { exact: true })).toHaveCount(0);
    const initialThemeColor = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    await page.locator("#theme-toggle").click();
    await page.waitForTimeout(120);
    const midTransitionThemeColor = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    await page.waitForTimeout(400);
    const finalThemeColor = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    assert.notEqual(midTransitionThemeColor, initialThemeColor);
    assert.notEqual(midTransitionThemeColor, finalThemeColor);
    await page.locator("#theme-toggle").click();
    await page.waitForTimeout(500);
    await expect(page.locator("#host-password-form")).toBeVisible();
    await expect(page.locator("#host-allow-dialog")).toHaveCount(0);
    await expect(page.locator('[data-action="open-host-allow"]')).toHaveCount(
      0,
    );
    await expect(page.locator("#connect-form")).toBeVisible();
    await expect(page.locator("#recent-connections")).toHaveValue("");
    await expect(page.locator("#recent-connections option")).toHaveCount(1);
    const shareButton = page.locator('[data-action="host-toggle"]');
    await expect(shareButton).toHaveAttribute("role", "switch");
    await expect(shareButton).toHaveAttribute("aria-checked", "false");
    const shareTooltip = page.locator("#share-disabled-reason");
    if (appState.host.access.passwordConfigured) {
      assert.equal(appState.host.access.passwordMode, "temporary");
      await expect(shareButton).toBeEnabled();
      await page.locator('[data-action="show-host-password"]').click();
      await expect(page.locator("#local-password")).toHaveAttribute(
        "type",
        "text",
      );
      await expect(
        page.getByRole("button", { name: "隐藏密码" }),
      ).toBeVisible();
      assert.equal(
        await page
          .locator(".password-input-wrap")
          .locator('[data-action="show-host-password"]')
          .count(),
        1,
      );
      const temporaryPassword = await page
        .locator("#local-password")
        .inputValue();
      assert.equal(temporaryPassword.length, 8);
      assert.ok(!JSON.stringify(appState).includes(temporaryPassword));
      await page.locator('[data-action="show-host-password"]').click();
      await expect(page.locator("#local-password")).toHaveAttribute(
        "type",
        "password",
      );
    } else {
      await expect(shareButton).toBeDisabled();
      await expect(shareTooltip).toHaveText("请先设置并保存访问密码。");
      await expect(shareTooltip).toBeHidden();
      await page.locator(".share-button-wrap").hover();
      await expect(shareTooltip).toBeVisible();
      await page.mouse.move(0, 0);
      await page.locator(".share-button-wrap").focus();
      await expect(shareTooltip).toBeVisible();
    }
    const windowSize = await page.evaluate(async () => {
      const current = window.__TAURI__.window.getCurrentWindow();
      const size = await current.innerSize();
      const scale = await current.scaleFactor();
      return { width: size.width / scale, height: size.height / scale };
    });
    assert.ok(
      Math.abs(windowSize.width - 867) <= 2,
      JSON.stringify(windowSize),
    );
    assert.ok(
      Math.abs(windowSize.height - 600) <= 2,
      JSON.stringify(windowSize),
    );
    for (const config of [tauriConfig, macosConfig]) {
      assert.equal(config.app.windows[0].minWidth, minimumViewport.width);
      assert.equal(config.app.windows[0].minHeight, minimumViewport.height);
    }
    for (const viewport of [minimumViewport, { width: 1000, height: 700 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const content = document
          .querySelector(".content")
          .getBoundingClientRect();
        const sidebar = document
          .querySelector(".sidebar")
          .getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          sidebarRight: sidebar.right,
          contentLeft: content.left,
          contentRight: content.right,
          contentBottom: content.bottom,
        };
      });
      assert.ok(layout.documentWidth <= viewport.width, JSON.stringify(layout));
      assert.ok(layout.bodyWidth <= viewport.width, JSON.stringify(layout));
      assert.ok(
        layout.sidebarRight <= layout.contentLeft,
        JSON.stringify(layout),
      );
      assert.ok(
        layout.contentRight <= viewport.width + 1,
        JSON.stringify(layout),
      );
      assert.ok(
        layout.contentBottom <= viewport.height + 1,
        JSON.stringify(layout),
      );
      const contentOverflow = await page
        .locator("#content")
        .evaluate((element) => element.scrollHeight - element.clientHeight);
      assert.ok(
        contentOverflow <= 1,
        `Content overflows by ${contentOverflow}px`,
      );
      const clippedControls = await page.evaluate(() => {
        const content = document
          .querySelector(".content")
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(
            "#host-password-form input, #host-password-form button, .share-state button, #connect-form input, #connect-form button",
          ),
        ]
          .map((control) => {
            const rect = control.getBoundingClientRect();
            return {
              name: control.name || control.textContent.trim(),
              left: rect.left,
              right: rect.right,
            };
          })
          .filter(
            (rect) =>
              rect.left < content.left - 1 || rect.right > content.right + 1,
          );
      });
      assert.deepEqual(clippedControls, []);
      await expect(page.locator("#partner-code")).toBeVisible();
      await expect(page.locator("#partner-password")).toBeVisible();
      await expect(
        page.locator('#connect-form button[type="submit"]'),
      ).toBeVisible();
      await page.locator('[data-route="settings"]').click();
      await expect(page.locator("#settings-form")).toBeVisible();
      await expect(page.locator("#native-path")).toHaveCount(0);
      await page.locator('[data-route="guide"]').click();
      await expect(
        page.getByRole("heading", { name: "连接指南", exact: true }),
      ).toBeVisible();
      await page.locator('[data-action="connect-code"]').click();
      await expect(page.locator("#partner-code")).toBeVisible();
    }
    await page.setViewportSize({ width: 867, height: 600 });
    await expect(page.locator("#partner-code")).toHaveAttribute(
      "pattern",
      "[0-9]{9}",
    );
    const smokePassword = "tauri-smoke-password";
    await page.evaluate(
      (password) =>
        window.lan.call("hostPassword", {
          password,
        }),
      smokePassword,
    );
    appState = await page.evaluate(() => window.lan.call("state"));
    assert.equal(appState.host.access.passwordConfigured, true);
    await expect(shareButton).toBeEnabled();
    await expect(shareTooltip).toHaveCount(0);
    await page.evaluate(() => {
      window.originalLanCall = window.lan.call;
      window.lan.call = async (method, input) => {
        if (method === "hostStart") {
          await new Promise((resolve) => {
            window.finishFakeHostStart = resolve;
          });
          throw new Error("测试授权失败");
        }
        return window.originalLanCall(method, input);
      };
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await shareButton.click();
    await expect(page.locator(".share-state [role=status]")).toHaveText(
      "正在开启",
    );
    await expect(shareButton).toHaveAttribute("aria-busy", "true");
    await expect
      .poll(() =>
        shareButton
          .locator(".switch-thumb")
          .evaluate((thumb) => getComputedStyle(thumb).animationName),
      )
      .toBe("share-toggle-spin");
    const thumb = shareButton.locator(".switch-thumb");
    const before = await thumb.evaluate(
      (element) => getComputedStyle(element).transform,
    );
    await expect
      .poll(() =>
        thumb.evaluate((element) => getComputedStyle(element).transform),
      )
      .not.toBe(before);
    await expect
      .poll(() =>
        shareButton.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() =>
        thumb.evaluate((element) => getComputedStyle(element).animationName),
      )
      .toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(shareButton).toBeDisabled();
    await expect(shareButton).toHaveAttribute("aria-checked", "false");
    await page.waitForFunction(
      () => typeof window.finishFakeHostStart === "function",
    );
    await page.evaluate(() => window.finishFakeHostStart());
    await expect(page.locator("#toast")).toContainText("测试授权失败");
    await expect(shareButton).toBeEnabled();
    await expect(shareButton).toHaveAttribute("aria-checked", "false");
    await page.evaluate(() => {
      window.lan.call = window.originalLanCall;
      delete window.originalLanCall;
      delete window.finishFakeHostStart;
    });
    const accessConfig = await fs.readFile(
      path.join(profile, "appdata", "SolunaRemote", "access", "access.json"),
      "utf8",
    );
    assert.doesNotMatch(accessConfig, new RegExp(smokePassword));
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "开始协助" })
      .click();
    await expect(page.locator("#partner-code")).toBeFocused();
    const id = await page.evaluate(
      (target) =>
        window.lan.call("add", {
          name: "Tauri VM smoke test 340403567",
          address: target,
        }),
      address,
    );
    await expect
      .poll(async () => {
        appState = await page.evaluate(() => window.lan.call("state"));
        return appState.devices.find((device) => device.id === id)?.status;
      })
      .toBeDefined();
    vmDevice = appState.devices.find((device) => device.id === id);
    assert.ok(vmDevice.address);
    await expect(page.locator("#recent-connections option")).toHaveCount(2);
    await page.locator("#partner-password").fill("old-password");
    await page.locator("#recent-connections").selectOption(id);
    await expect(page.locator("#partner-code")).toHaveValue("340403567");
    await expect(page.locator("#partner-password")).toHaveValue("");
    await expect(page.locator("#partner-password")).toBeFocused();
    await page.evaluate(() => {
      window.originalLanCall = window.lan.call;
      window.lan.call = async (method, input) => {
        if (method === "recentPassword") return "saved-test-password";
        return window.originalLanCall(method, input);
      };
    });
    await page.locator("#recent-connections").selectOption(id);
    await expect(page.locator("#partner-password")).toHaveValue(
      "saved-test-password",
    );
    await page.evaluate(() => {
      window.lan.call = async (method, input) => {
        if (method === "recentPassword")
          return new Promise((resolve) => {
            window.finishRecentPassword = resolve;
          });
        return window.originalLanCall(method, input);
      };
    });
    await page.locator("#recent-connections").selectOption(id);
    await page.waitForFunction(() => !!window.finishRecentPassword);
    await page.locator("#partner-password").fill("manually-edited-password");
    await page.evaluate(() => window.finishRecentPassword("stale-password"));
    await expect(page.locator("#partner-password")).toHaveValue(
      "manually-edited-password",
    );
    await page.evaluate(() => {
      window.lan.call = window.originalLanCall;
      delete window.originalLanCall;
      delete window.finishRecentPassword;
    });
    assert.equal(errors.length, 0, errors.join("\n"));
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/tauri-vm-smoke.png" });
    console.log(
      JSON.stringify(
        {
          runtime: "Tauri + WebView2 + Rust backend",
          version: appState.version,
          backendReady: true,
          nativeEngineAvailable: appState.engines.nativeAvailable,
          hostBundleAvailable: appState.host.available,
          vm: {
            address: vmDevice.address,
            online: vmDevice.status.online,
            error: vmDevice.status.error,
          },
          streamVerified: false,
          screenshot: "test-results/tauri-vm-smoke.png",
        },
        null,
        2,
      ),
    );
    await page.evaluate(() =>
      window.setTimeout(
        () =>
          void window.__TAURI__.core.invoke("window_action", {
            action: "close",
          }),
        0,
      ),
    );
    await Promise.race([
      launcherExit,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Tauri did not exit after closing its UI.")),
          10000,
        ),
      ),
    ]);
  } finally {
    if (launcher.exitCode === null) {
      try {
        await page?.evaluate(() =>
          window.setTimeout(
            () =>
              void window.__TAURI__.core.invoke("window_action", {
                action: "close",
              }),
            0,
          ),
        );
        const exitCode = await Promise.race([
          launcherExit,
          new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
        ]);
        if (exitCode === null) launcher.kill();
      } catch {
        if (launcher.exitCode === null) launcher.kill();
      }
    }
    await browser?.close();
    await launcherExit;
    await fs.rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
