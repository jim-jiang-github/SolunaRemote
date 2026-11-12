const { test, expect, _electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { DEFAULT_SETTINGS } = require("../../app/core/validation.cjs");

test.describe
  .serial("Rendered Electron with IPC-mocked password authentication and native player", () => {
  let directory, profile, log, server, port, engine, app, page;
  let online = true;
  const errors = [];
  async function launch() {
    app = await _electron.launch({
      args: [path.resolve("tests", "fixtures", "electron-entry.cjs")],
      env: {
        ...process.env,
        LAN_TEST_PROFILE: profile,
        LAN_TEST_PORT: String(port),
        LAN_TEST_LOG: log,
      },
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "你的设备，随时连接" }),
    ).toBeVisible();
  }
  test.beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lan-access-ui-"));
    profile = path.join(directory, "profile");
    fs.mkdirSync(profile);
    log = path.join(directory, "actions.jsonl");
    fs.writeFileSync(log, "");
    engine = path.join(directory, "soluna-stream-fixture.exe");
    fs.writeFileSync(engine, "Test-only sentinel; never executed.");
    fs.writeFileSync(
      path.join(profile, "devices.json"),
      JSON.stringify({
        version: 1,
        devices: [],
        settings: { ...DEFAULT_SETTINGS, nativePath: engine },
      }),
    );
    server = http.createServer((_request, response) => {
      response.writeHead(online ? 200 : 503, {
        "Content-Type": "application/xml",
      });
      response.end(
        online
          ? '<root status_code="200"><hostname>TEST LAN peer</hostname><uniqueid>test-peer</uniqueid><appversion>7.1.431.-1</appversion><state>SUNSHINE_SERVER_FREE</state></root>'
          : "offline",
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    await launch();
  });
  test.afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("opens sandboxed real UI with device-code entry and no manual pairing controls", async ({}, info) => {
    await expect(page).toHaveTitle("SolunaRemote");
    await expect(page.locator(".brand strong")).toHaveText("SolunaRemote");
    expect(await app.evaluate(({ app }) => app.getName())).toBe("SolunaRemote");
    expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
    await expect(
      page.getByRole("heading", { name: "从你的第一台电脑开始" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "PIN 配对" })).toHaveCount(0);
    await page
      .getByRole("button", { name: "设备码连接", exact: true })
      .first()
      .click();
    await expect(page.getByLabel("设备码", { exact: true })).toBeVisible();
    await page
      .getByLabel("访问密码", { exact: true })
      .fill("not-retained-password");
    await page
      .locator("#connect-dialog")
      .getByRole("button", { name: "取消" })
      .click();
    await page.screenshot({ path: info.outputPath("device-code-entry.png") });
  });

  test("rejects public manual targets and adds a real loopback discovery fixture", async () => {
    await page
      .locator(".heading-buttons")
      .getByRole("button", { name: "添加设备", exact: true })
      .click();
    const form = page.locator("#device-form");
    await form
      .getByLabel("设备名称", { exact: true })
      .fill("设备 123456789012");
    await form.getByLabel("内网地址").fill("8.8.8.8");
    await form.getByRole("button", { name: "添加设备", exact: true }).click();
    await expect(page.locator("#device-error")).toContainText("公网");
    await form.getByLabel("内网地址").fill(`127.0.0.1:${port}`);
    await form.getByRole("button", { name: "添加设备", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "进入桌面", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: "PIN 配对" })).toHaveCount(0);
  });

  test("wrong password cannot spawn a native player, correct password renders first frame and can stop", async () => {
    await page.getByRole("button", { name: "进入桌面", exact: true }).click();
    const form = page.locator("#connect-form");
    await form.getByLabel("设备码", { exact: true }).fill("123456789012");
    await form
      .getByLabel("访问密码", { exact: true })
      .fill("wrong-long-password");
    await form.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.locator("#connect-error")).toContainText("密码验证失败");
    expect(fs.readFileSync(log, "utf8")).not.toContain('"action":"stream"');
    await form
      .getByLabel("访问密码", { exact: true })
      .fill("UI-test-password-2026");
    await form.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.locator("#connect-dialog")).not.toBeVisible();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lan.call("state"))).session?.phase,
      )
      .toBe("streaming");
    expect(
      await page.locator("#connect-form input[name=password]").inputValue(),
    ).toBe("");
    await page.locator('[data-action="stop"]').click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lan.call("state"))).session,
      )
      .toBeNull();
    const stored = fs.readFileSync(path.join(profile, "devices.json"), "utf8");
    expect(stored).not.toContain("UI-test-password-2026");
    expect(fs.readFileSync(log, "utf8")).not.toContain("UI-test-password-2026");
  });

  test("online to offline to online transitions gate real enabled controls", async () => {
    online = false;
    await page.getByRole("button", { name: "刷新设备状态" }).click();
    await expect(
      page.getByRole("button", { name: "进入桌面", exact: true }),
    ).toBeDisabled();
    online = true;
    await page.getByRole("button", { name: "刷新设备状态" }).click();
    await expect(
      page.getByRole("button", { name: "进入桌面", exact: true }),
    ).toBeEnabled();
  });

  test("host password, scoped firewall and start/stop actions work in the same IPC-mocked rendered UI", async ({}, info) => {
    await page.getByRole("button", { name: "本机共享", exact: true }).click();
    await expect(page.locator("#host-device-code")).toHaveText("555555555555");
    await page.getByLabel("本机访问密码").fill("host-test-password-2026");
    await page.getByRole("button", { name: "保存访问密码" }).click();
    await expect(
      page.getByText("访问密码已设置，不在界面回显。"),
    ).toBeVisible();
    await page.getByLabel("控制端 IPv4").fill("8.8.8.8");
    await page
      .getByRole("button", { name: "授权此设备访问（管理员）" })
      .click();
    await expect(page.locator("#toast")).toContainText(
      "TEST invalid private address",
    );
    await page.getByLabel("控制端 IPv4").fill("192.168.1.20");
    await page
      .getByRole("button", { name: "授权此设备访问（管理员）" })
      .click();
    await page
      .getByRole("button", { name: "开启本机共享", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "停止本机共享", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("本机访问密码")).toBeDisabled();
    await expect(page.getByLabel("四位 PIN")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("integrated-host-password.png"),
    });
    await page
      .getByRole("button", { name: "停止本机共享", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "开启本机共享", exact: true }),
    ).toBeEnabled();
    expect(fs.readFileSync(log, "utf8")).toContain('"action":"host-firewall"');
  });

  test("settings, favorites and quick application records persist across a real restart", async () => {
    await page.locator("[data-device]").first().click();
    await page.locator('.heading-buttons [data-action="favorite"]').click();
    await page
      .getByRole("button", { name: "添加快捷启动", exact: true })
      .click();
    const shortcut = page.locator("#shortcut-form");
    await shortcut.locator('[name="name"]').fill("TEST Desktop shortcut");
    await shortcut.locator('[name="app"]').fill("Desktop");
    await shortcut.locator('[type="submit"]').click();
    await expect(
      page.getByRole("button", { name: "TEST Desktop shortcut", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "串流设置", exact: true }).click();
    await page
      .locator('#settings-form [name="resolution"]')
      .selectOption("1280x720");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await app.close();
    await launch();
    const saved = JSON.parse(
      fs.readFileSync(path.join(profile, "devices.json"), "utf8"),
    );
    expect(saved.settings.resolution).toBe("1280x720");
    expect(saved.devices[0].favorite).toBe(true);
    expect(saved.devices[0].shortcuts[0].name).toBe("TEST Desktop shortcut");
  });

  test("mDNS fixture discovery, removal cancellation and explicit removal work without runtime errors", async () => {
    await page.getByRole("button", { name: "发现设备", exact: true }).click();
    await expect(page.locator("#discovery-results")).toContainText(
      "TEST Sunshine",
    );
    await page
      .locator("#discover-dialog")
      .getByRole("button", { name: "完成" })
      .click();
    await page.locator("[data-device]").first().click();
    await page.getByRole("button", { name: "移除设备", exact: true }).click();
    await page
      .locator("#confirm-dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "设备 123456789012", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "移除设备", exact: true }).click();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "从你的第一台电脑开始" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});
