const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { spawn } = require("node:child_process");
const { chromium } = require("@playwright/test");
const { version } = require("../package.json");
const execute = promisify(execFile);

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

async function processTreeMemory(rootPid) {
  const command = `
$rootPid = ${rootPid}
$processes = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.HashSet[int]]::new()
$null = $ids.Add($rootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $processes) {
    if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
      $changed = $true
    }
  }
}
$items = @(foreach ($id in $ids) {
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process) {
    [pscustomobject]@{ pid = $id; name = $process.ProcessName; workingSetBytes = $process.WorkingSet64 }
  }
})
$sum = ($items | Measure-Object -Property workingSetBytes -Sum).Sum
[pscustomobject]@{ processCount = $items.Count; workingSetBytes = $sum; processes = $items } | ConvertTo-Json -Depth 4 -Compress
`;
  const { stdout } = await execute(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  return JSON.parse(stdout);
}

async function waitForExit(child, timeout = 10000) {
  if (child.exitCode !== null) return child.exitCode;
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop app did not exit cleanly.")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function benchmarkElectron(profile) {
  const executable = path.resolve(
    "release",
    `SolunaRemote-${version}-windows-x64.exe`,
  );
  const sizeBytes = (await fs.stat(executable)).size;
  await fs.mkdir(profile, { recursive: true });
  const started = performance.now();
  const launcher = spawn(
    executable,
    [`--user-data-dir=${profile}`, "--remote-debugging-port=0"],
    { stdio: "ignore" },
  );
  let launchError;
  launcher.once("error", (error) => {
    launchError = error;
  });
  let browser;
  try {
    const debugFile = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (launcher.exitCode !== null)
        throw new Error(
          `Electron exited before WebView startup: ${launcher.exitCode}`,
        );
      try {
        const [portLine] = (await fs.readFile(debugFile, "utf8")).split("\n");
        const port = Number(portLine);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 10000,
        });
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !error.message.includes("ECONNREFUSED"))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(browser, "Electron Chromium DevTools endpoint did not start.");
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(
      () => typeof window.lan?.call === "function",
      null,
      { timeout: 15000 },
    );
    const state = await page.evaluate(() => window.lan.call("state"));
    assert.equal(state.version, version);
    const startupMs = Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const memory = await processTreeMemory(launcher.pid);
    return {
      runtime: "Electron",
      startupMs,
      memory,
      packageBytes: sizeBytes,
    };
  } finally {
    if (launcher.exitCode === null) {
      try {
        await browser
          ?.contexts()[0]
          ?.pages()[0]
          ?.locator('[data-window="close"]')
          .click();
        await waitForExit(launcher);
      } catch {
        if (launcher.exitCode === null) launcher.kill();
      }
    }
    await browser?.close();
    if (launcher.exitCode === null) await waitForExit(launcher);
  }
}

async function benchmarkTauri(profile) {
  const executable = path.resolve(
    "src-tauri",
    "target",
    "release",
    "solunaremote.exe",
  );
  const sizeBytes = (await fs.stat(executable)).size;
  const packageBytes = (
    await fs.stat(
      path.resolve(
        "src-tauri",
        "target",
        "release",
        "bundle",
        "nsis",
        `SolunaRemote_${version}_x64-setup.exe`,
      ),
    )
  ).size;
  const port = await freePort();
  const started = performance.now();
  const launcher = spawn(executable, [], {
    env: {
      ...process.env,
      APPDATA: path.join(profile, "appdata"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview"),
    },
    stdio: "ignore",
  });
  let browser;
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
    assert.ok(endpoint, "Tauri WebView2 did not start.");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 10000,
    });
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(
      () => typeof window.lan?.call === "function",
      null,
      { timeout: 15000 },
    );
    const state = await page.evaluate(() => window.lan.call("state"));
    assert.equal(state.version, version);
    const startupMs = Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const memory = await processTreeMemory(launcher.pid);
    return {
      runtime: "Tauri + WebView2 + Node sidecar",
      startupMs,
      executableBytes: sizeBytes,
      memory,
      packageBytes,
    };
  } finally {
    if (launcher.exitCode === null) {
      try {
        await browser
          ?.contexts()[0]
          ?.pages()[0]
          ?.evaluate(() =>
            window.__TAURI__.core.invoke("window_action", { action: "close" }),
          );
        await waitForExit(launcher);
      } catch {
        if (launcher.exitCode === null) launcher.kill();
      }
    }
    await browser?.close();
    if (launcher.exitCode === null) await waitForExit(launcher);
  }
}

async function main() {
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "solunaremote-desktop-compare-"),
  );
  try {
    const electron = await benchmarkElectron(path.join(profile, "electron"));
    const tauri = await benchmarkTauri(path.join(profile, "tauri"));
    console.log(
      JSON.stringify(
        {
          methodology:
            "Same host, fresh isolated profiles; startup ends when the UI bridge and backend state RPC are ready. Working set is sampled after an 8-second idle settle and sums the app process tree. Artifacts compared are Electron portable EXE and Tauri NSIS installer.",
          electron,
          tauri,
          changes: {
            artifactSizeReductionPercent:
              Math.round(
                (1 - tauri.packageBytes / electron.packageBytes) * 1000,
              ) / 10,
            workingSetBytes:
              electron.memory.workingSetBytes - tauri.memory.workingSetBytes,
          },
        },
        null,
        2,
      ),
    );
  } finally {
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
