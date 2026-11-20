const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("@playwright/test");

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

async function launchTauri(executable, profile) {
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
    if (!endpoint)
      throw new Error("Tauri WebView2 did not expose its test endpoint.");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 10000,
    });
    const context = browser.contexts()[0];
    page = context.pages()[0] || (await context.waitForEvent("page"));
    return {
      launcher,
      browser,
      page,
      async close() {
        if (launcher.exitCode === null) {
          try {
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
                  () => reject(new Error("Tauri did not close.")),
                  10000,
                ),
              ),
            ]);
          } catch {
            if (launcher.exitCode === null) launcher.kill();
          }
        }
        await browser.close();
        await launcherExit;
      },
    };
  } catch (error) {
    if (launcher.exitCode === null) launcher.kill();
    await browser?.close();
    await launcherExit;
    throw error;
  }
}

module.exports = { launchTauri };
