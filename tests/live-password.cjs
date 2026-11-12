// Opt-in: real VM desktop app behind an authenticated, loopback-only SSH CDP tunnel.
const assert = require("node:assert/strict");
const { _electron, chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DEFAULT_SETTINGS } = require("../app/core/validation.cjs");

async function nativeEvidence(
  playerPid,
  output,
  extendedControls = false,
  remoteTarget = null,
) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LiveWindow {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point point);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
 [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint key, uint mapType);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$null = [LiveWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$process = Get-Process -Id ${playerPid}
if ($process.ProcessName -ne 'soluna-stream') { throw 'Tracked native child identity changed.' }
$window = $process.MainWindowHandle
if ($window -eq 0) { throw 'Native SDL window is not visible.' }
$null = [LiveWindow]::SetForegroundWindow($window)
Start-Sleep -Milliseconds 300
if ([LiveWindow]::GetForegroundWindow() -ne $window) {
 $null = [LiveWindow]::SetWindowPos($window,[IntPtr](-1),0,0,0,0,19)
 $null = [LiveWindow]::SetWindowPos($window,[IntPtr](-2),0,0,0,0,19)
 $bounds = New-Object LiveWindow+RECT
 if (-not [LiveWindow]::GetWindowRect($window,[ref]$bounds)) { throw 'Cannot locate tracked native title bar.' }
 # These test fixtures use pillarboxed video; focus the non-interactive left gutter.
 $point = New-Object Drawing.Point(($bounds.Left+20),($bounds.Top+80))
 [System.Windows.Forms.Cursor]::Position = $point
 Start-Sleep -Milliseconds 100
 if ([LiveWindow]::WindowFromPoint($point) -ne $window) { throw 'Tracked native title bar is obscured; no input sent.' }
 [LiveWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 100
 [LiveWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 300
}
if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Native window could not safely receive test keystrokes.' }
Start-Sleep -Milliseconds 800
${
  remoteTarget
    ? `
$targetBounds = New-Object LiveWindow+RECT
if (-not [LiveWindow]::GetWindowRect($window,[ref]$targetBounds)) { throw 'Cannot locate video for remote mouse test.' }
$width = $targetBounds.Right-$targetBounds.Left
$height = $targetBounds.Bottom-$targetBounds.Top-54
$scale = [Math]::Min($width/${remoteTarget.width},$height/${remoteTarget.height})
$videoX = ($width-${remoteTarget.width}*$scale)/2
$videoY = 54+($height-${remoteTarget.height}*$scale)/2
$point = New-Object Drawing.Point([int]($targetBounds.Left+$videoX+${remoteTarget.x}*$scale),[int]($targetBounds.Top+$videoY+${remoteTarget.y}*$scale))
[System.Windows.Forms.Cursor]::Position = $point
Start-Sleep -Milliseconds 200
if ([LiveWindow]::WindowFromPoint($point) -ne $window) { throw 'Owned video obscured; no remote click sent.' }
[LiveWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[LiveWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 300
`
    : ""
}
foreach ($key in 49..54) {
 if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Focus changed; no further test keys sent.' }
 $scan = [byte][LiveWindow]::MapVirtualKey($key,0)
 [LiveWindow]::keybd_event([byte]$key,$scan,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 300
 [LiveWindow]::keybd_event([byte]$key,$scan,2,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 800
$rect = New-Object LiveWindow+RECT
if (-not [LiveWindow]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot get native window bounds.' }
$bitmap = New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
 if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Owned window lost foreground; capture refused.' }
 $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
 if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Focus changed during capture; image discarded.' }
 $bitmap.Save('${output.replaceAll("'", "''")}',[Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
function ClickOwned([int]$x,[int]$y) {
 $point = New-Object Drawing.Point($x,$y)
 [System.Windows.Forms.Cursor]::Position = $point
 Start-Sleep -Milliseconds 100
 if ([LiveWindow]::WindowFromPoint($point) -ne $window) { throw 'Session control is obscured; no click sent.' }
 [LiveWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [LiveWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 250
}
function CaptureOwned([string]$path) {
 $image = New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
 $canvas = [Drawing.Graphics]::FromImage($image)
 try {
  if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Owned window lost foreground; capture refused.' }
  $canvas.CopyFromScreen($rect.Left,$rect.Top,0,0,$image.Size)
  if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Focus changed during capture; image discarded.' }
  $image.Save($path,[Drawing.Imaging.ImageFormat]::Png)
 }
 finally { $canvas.Dispose(); $image.Dispose() }
}
${
  extendedControls
    ? `
ClickOwned ($rect.Right-215) ($rect.Top+27)
CaptureOwned '${path.join(path.dirname(output), "native-control-center.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-170) ($rect.Top+141)
CaptureOwned '${path.join(path.dirname(output), "native-muted.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-170) ($rect.Top+141)
ClickOwned ($rect.Right-170) ($rect.Top+91)
if (-not [LiveWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Cannot get fullscreen window bounds.' }
CaptureOwned '${path.join(path.dirname(output), "native-fullscreen.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-170) ($rect.Top+91)
if (-not [LiveWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Cannot get restored window bounds.' }
ClickOwned ($rect.Right-170) ($rect.Top+191)
ClickOwned ($rect.Right-215) ($rect.Top+27)
CaptureOwned '${path.join(path.dirname(output), "native-performance.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-23) ($rect.Top+27)
`
    : ""
}
Write-Output 'Captured native rendered window and exercised owned session controls; remote key receipt requires separate assertion.'
`;
  let result;
  try {
    result = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 30000 },
    );
  } catch (error) {
    const reason =
      error.stderr?.match(/<S S="Error">([^<]+)/)?.[1] ??
      error.code ??
      error.signal ??
      "OS helper timed out";
    throw new Error(`Native UI evidence failed: ${reason}`);
  }
  console.log(result.stdout.trim());
}

async function main() {
  const endpoint = process.argv[2];
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? ""))
    throw new Error("Supply loopback SSH CDP tunnel URL.");
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "lan-live-password-"),
  );
  const output = path.resolve("test-results", "live-password");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(profile, "devices.json"),
    JSON.stringify({
      version: 1,
      devices: [],
      settings: {
        ...DEFAULT_SETTINGS,
        resolution: "1280x720",
        fps: 30,
        bitrate: 4000,
        codec: "H.264",
        displayMode: "windowed",
      },
    }),
  );
  const password = crypto.randomBytes(24).toString("base64url");
  let remote, hostPage, local, page;
  try {
    const info = await (await fetch(`${endpoint}/json/version`)).json();
    const websocket = new URL(info.webSocketDebuggerUrl);
    websocket.host = new URL(endpoint).host;
    remote = await chromium.connectOverCDP(websocket.href);
    hostPage = remote
      .contexts()[0]
      .pages()
      .find((entry) => entry.url().endsWith("index.html"));
    assert.ok(hostPage);
    await hostPage.evaluate(() => window.lan.call("hostStop"));
    await hostPage
      .getByRole("button", { name: "本机共享", exact: true })
      .click();
    await hostPage.getByLabel("共享网卡").selectOption("172.22.98.13");
    await hostPage.getByLabel("本机访问密码").fill(password);
    await hostPage
      .getByRole("button", { name: "保存访问密码", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await hostPage.evaluate(() => window.lan.call("state"))).host.access
            .passwordConfigured,
      )
      .toBe(true);
    const code = await hostPage.locator("#host-device-code").textContent();
    assert.match(code, /^\d{12}$/);
    await hostPage
      .getByRole("button", { name: "开启本机共享", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await hostPage.evaluate(() => window.lan.call("state"))).host.phase,
        { timeout: 75000 },
      )
      .toBe("running");
    await expect
      .poll(
        async () =>
          (await hostPage.evaluate(() => window.lan.call("state"))).host.access
            .listening,
      )
      .toBe(true);
    await hostPage
      .getByRole("button", { name: "本机共享", exact: true })
      .click();
    await hostPage.screenshot({
      path: path.join(output, "vm-integrated-host.png"),
    });
    console.log(
      "Integrated VM host ready; device password configured through actual UI.",
    );
    local = await _electron.launch({
      executablePath: path.resolve(
        "release",
        "win-unpacked",
        "SolunaRemote.exe",
      ),
      args: [`--user-data-dir=${profile}`],
    });
    page = await local.firstWindow();
    await page
      .getByRole("button", { name: "设备码连接", exact: true })
      .first()
      .click();
    const form = page.locator("#connect-form");
    await form.getByLabel("设备码", { exact: true }).fill(code);
    await form
      .getByLabel("访问密码", { exact: true })
      .fill("incorrect-live-test-password");
    await form.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.locator("#connect-error")).toContainText("密码验证失败", {
      timeout: 25000,
    });
    assert.equal(
      (await page.evaluate(() => window.lan.call("state"))).session,
      null,
    );
    console.log("Actual wrong-password attempt rejected before streaming.");
    await form.getByLabel("访问密码", { exact: true }).fill(password);
    await form.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.locator("#connect-dialog")).not.toBeVisible({
      timeout: 40000,
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lan.call("state"))).session?.phase,
        { timeout: 45000 },
      )
      .toBe("streaming");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lan.call("state"))).session?.stats
            ?.rendered ?? 0,
        { timeout: 15000 },
      )
      .toBeGreaterThan(30);
    const videoState = await page.evaluate(() => window.lan.call("state"));
    const result = {
      fixture: false,
      version: videoState.version,
      target: "172.22.98.13",
      independentSunshineInstalled: false,
      authentication:
        "LAN device code; correct TLS ECDHE-PSK password accepted; wrong password rejected",
      manualPairingCode: false,
      phase: videoState.session.phase,
      stats: videoState.session.stats,
      keyboardVerified: false,
      audibleAudioVerified: false,
    };
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      "Actual password-authenticated video rendered:",
      JSON.stringify(result.stats),
    );
    await hostPage.bringToFront();
    await hostPage.getByLabel("控制端 IPv4").fill("");
    await hostPage.getByLabel("控制端 IPv4").focus();
    const box = await hostPage.getByLabel("控制端 IPv4").boundingBox();
    const remoteTarget = await hostPage.evaluate((box) => {
      const input = document.querySelector("#host-client-address");
      window.remoteMouseEvidence = false;
      const onPointer = (event) => {
        window.remoteMouseDetails = {
          x: event.clientX,
          y: event.clientY,
          id: event.target.id,
        };
        if (event.target.id === "host-client-address") {
          window.remoteMouseEvidence = true;
          document.removeEventListener("pointerdown", onPointer, true);
        }
      };
      document.addEventListener("pointerdown", onPointer, true);
      input.blur();
      return {
        width: screen.width,
        height: screen.height,
        x: screenX + (outerWidth - innerWidth) / 2 + box.x + box.width / 2,
        y: screenY + box.y + box.height / 2,
      };
    }, box);
    assert.ok(
      remoteTarget.width / remoteTarget.height < 1,
      "VM test requires known portrait pillarbox geometry",
    );
    const players = await local.evaluate(() =>
      process
        ._getActiveHandles()
        .filter(
          (entry) =>
            entry.constructor.name === "ChildProcess" &&
            entry.spawnfile?.endsWith("soluna-stream.exe") &&
            entry.exitCode === null,
        )
        .map((entry) => entry.pid),
    );
    assert.equal(
      players.length,
      1,
      "Exactly one tracked native player must be running",
    );
    await nativeEvidence(
      players[0],
      path.join(output, "native-live-desktop.png"),
      false,
      remoteTarget,
    );
    console.log(
      "Actual VM pointer target:",
      await hostPage.evaluate(() => window.remoteMouseDetails),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lan.call("state"))).session?.stats
            ?.keyboardEvents ?? 0,
      )
      .toBeGreaterThanOrEqual(12);
    await expect(hostPage.getByLabel("控制端 IPv4")).toHaveValue("123456", {
      timeout: 5000,
    });
    assert.equal(
      await hostPage.evaluate(() => window.remoteMouseEvidence),
      true,
    );
    await page.screenshot({ path: path.join(output, "local-live-client.png") });
    result.keyboardVerified = true;
    result.mouseVerified = true;
    await hostPage.screenshot({
      path: path.join(output, "vm-keyboard-and-mouse.png"),
    });
    result.stats = (
      await page.evaluate(() => window.lan.call("state"))
    ).session.stats;
    result.keyboardEvidence =
      "Six actual keypresses through native SDL/common-c appeared in the VM app textbox";
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(
        "Client:",
        await page.locator("#connect-error").textContent(),
      );
      await page.screenshot({ path: path.join(output, "client-failure.png") });
    }
    if (hostPage && !hostPage.isClosed()) {
      console.error(
        "Host:",
        (await hostPage.evaluate(() => window.lan.call("state"))).host,
      );
      await hostPage.screenshot({
        path: path.join(output, "host-failure.png"),
      });
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) {
      await page.evaluate(async () => {
        await window.lan.call("cancelConnect");
        const state = await window.lan.call("state");
        if (state.session) await window.lan.call("cancel", state.session.id);
      });
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.lan.call("state"))).session,
          { timeout: 10000 },
        )
        .toBeNull();
    }
    await local?.close();
    if (hostPage && !hostPage.isClosed())
      await hostPage.evaluate(() => window.lan.call("hostStop"));
    await remote?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
module.exports = { nativeEvidence };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
