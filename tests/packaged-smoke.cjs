const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { _electron, chromium, expect } = require("@playwright/test");
const { version } = require("../package.json");

async function main() {
  const executablePath = path.resolve(
    process.argv[2] || path.join("release", "win-unpacked", "SolunaRemote.exe"),
  );
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "solunaremote-packaged-"),
  );
  const portable = process.argv.includes("--portable");
  let application;
  let browser;
  let launcher;
  let launcherExit;
  let page;
  try {
    if (portable) {
      // NSIS does not forward Node inspector output, so attach to Chromium instead.
      launcher = spawn(
        executablePath,
        [`--user-data-dir=${profile}`, "--remote-debugging-port=0"],
        { stdio: "ignore" },
      );
      let launchError;
      launcher.on("error", (error) => {
        launchError = error;
      });
      launcherExit = new Promise((resolve) => launcher.once("close", resolve));
      const debugFile = path.join(profile, "DevToolsActivePort");
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(debugFile)) {
        if (launchError) throw launchError;
        if (launcher.exitCode !== null || Date.now() > deadline)
          throw new Error(
            "Portable application failed to expose its isolated debugging endpoint.",
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const port = Number(fs.readFileSync(debugFile, "utf8").split("\n")[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Invalid portable debugging port.");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 10000,
      });
      const context = browser.contexts()[0];
      page = context.pages()[0] || (await context.waitForEvent("page"));
    } else {
      application = await _electron.launch({
        executablePath,
        args: [`--user-data-dir=${profile}`],
        timeout: 30000,
      });
      page = await application.firstWindow();
    }
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "从你的第一台电脑开始", exact: true }),
    ).toBeVisible();
    if (application) {
      expect(
        await application.evaluate(({ app }) => app.getPath("userData")),
      ).toBe(profile);
      expect(await application.evaluate(({ app }) => app.getVersion())).toBe(
        version,
      );
      expect(await application.evaluate(({ app }) => app.getName())).toBe(
        "SolunaRemote",
      );
    }
    await expect(page).toHaveTitle("SolunaRemote");
    await expect(page.locator(".brand strong")).toHaveText("SolunaRemote");
    const state = await page.evaluate(() => window.lan.call("state"));
    expect(state.version).toBe(version);
    expect(state.engines.nativeAvailable).toBe(true);
    expect(state.host.available).toBe(true);
    expect(state.host.phase).toBe("stopped");
    expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
    await page.locator('[data-route="host"]').click();
    await expect(
      page.getByRole("heading", { name: "本机共享", exact: true }),
    ).toBeVisible();
    await page.locator('[data-route="settings"]').click();
    await expect(page.locator("#settings-form")).toBeVisible();
    await page.locator('[data-route="devices"]').click();
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: path.join(
        "test-results",
        portable ? "portable-desktop.png" : "packaged-desktop.png",
      ),
    });
    expect(errors).toEqual([]);
    console.log(
      `${portable ? "Portable EXE" : "Packaged Windows application"} ${version}: launch, sandbox, isolated profile and navigation OK.`,
    );
  } catch (error) {
    console.error("Packaged smoke failed before cleanup:", error);
    throw error;
  } finally {
    await application?.close();
    if (browser) {
      if (page && !page.isClosed())
        await page.locator('[data-window="close"]').click();
      await browser.close();
    }
    if (launcherExit) {
      let timer;
      try {
        await Promise.race([
          launcherExit,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              launcher.kill();
              reject(
                new Error(
                  "Portable launcher did not exit after closing its UI.",
                ),
              );
            }, 60000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
