const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");
const { parseAddress } = require("../app/core/validation.cjs");
const { version } = require("../package.json");

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
  const address = parseAddress(process.argv[3] || "172.22.98.13").address;
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
    const id = await page.evaluate(
      (target) =>
        window.lan.call("add", {
          name: "Tauri VM smoke test",
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
    assert.equal(vmDevice.address, address);
    assert.equal(errors.length, 0, errors.join("\n"));
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/tauri-vm-smoke.png" });
    console.log(
      JSON.stringify(
        {
          runtime: "Tauri + WebView2 + Node sidecar",
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
