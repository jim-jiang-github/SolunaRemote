// Opt-in: real VM desktop app behind an authenticated, loopback-only SSH CDP tunnel.
const assert = require("node:assert/strict");
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { launchTauri } = require("./tauri-launch.cjs");

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
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
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
if (${remoteTarget ? "$true" : "$false"}) {
 foreach ($key in 49..54) {
  if ([LiveWindow]::GetForegroundWindow() -ne $window) { throw 'Focus changed; no further test keys sent.' }
  $scan = [byte][LiveWindow]::MapVirtualKey($key,0)
  [LiveWindow]::keybd_event([byte]$key,$scan,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  [LiveWindow]::keybd_event([byte]$key,$scan,2,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
 }
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
function DoubleClickOwned([int]$x,[int]$y) {
 $point = New-Object Drawing.Point($x,$y)
 [System.Windows.Forms.Cursor]::Position = $point
 Start-Sleep -Milliseconds 100
 if ([LiveWindow]::WindowFromPoint($point) -ne $window) { throw 'Session title bar is obscured; no double-click sent.' }
 [LiveWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [LiveWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 90
 [LiveWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [LiveWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 300
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
if ([LiveWindow]::IsZoomed($window)) { throw 'Native UI test must start with a restored window.' }
DoubleClickOwned ($rect.Left+300) ($rect.Top+27)
if (-not [LiveWindow]::IsZoomed($window)) { throw 'Title-bar double-click did not maximize the window.' }
DoubleClickOwned ($rect.Left+300) ($rect.Top+27)
if ([LiveWindow]::IsZoomed($window)) { throw 'Title-bar double-click did not restore the window.' }
ClickOwned ($rect.Right-215) ($rect.Top+27)
CaptureOwned '${path.join(path.dirname(output), "native-control-center.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-264) ($rect.Top+136)
ClickOwned ($rect.Left+554) ($rect.Top+27)
ClickOwned ($rect.Left+638) ($rect.Top+27)
ClickOwned ($rect.Right-170) ($rect.Top+230)
CaptureOwned '${path.join(path.dirname(output), "native-muted.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-170) ($rect.Top+230)
ClickOwned ($rect.Right-170) ($rect.Top+190)
if (-not [LiveWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Cannot get fullscreen window bounds.' }
CaptureOwned '${path.join(path.dirname(output), "native-fullscreen.png").replaceAll("'", "''")}'
ClickOwned ($rect.Right-170) ($rect.Top+190)
if (-not [LiveWindow]::GetWindowRect($window,[ref]$rect)) { throw 'Cannot get restored window bounds.' }
ClickOwned ($rect.Right-170) ($rect.Top+270)
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

async function nativePlayerPid(parentPid) {
  const script = `
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add(${parentPid})
do {
 $changed = $false
 foreach ($process in $processes) {
  if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
 }
} while ($changed)
$players = @($processes | Where-Object { $_.Name -eq 'soluna-stream.exe' -and $owned.Contains([int]$_.ProcessId) })
if ($players.Count -ne 1) { throw "Expected one owned soluna-stream.exe; found $($players.Count)." }
Write-Output $players[0].ProcessId
`;
  const result = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 15000 },
  );
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Could not identify the owned native player process.");
  return pid;
}

async function main() {
  const endpoint = process.argv[2];
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? ""))
    throw new Error("Supply loopback SSH CDP tunnel URL.");
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "lan-live-password-"),
  );
  const userData = path.join(profile, "appdata", "SolunaRemote");
  const output = path.resolve("test-results", "live-password");
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(
    path.join(userData, "devices.json"),
    JSON.stringify({
      version: 1,
      devices: [],
      settings: {
        moonlightPath: "",
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
    for (const candidate of remote
      .contexts()
      .flatMap((context) => context.pages())) {
      if (
        await candidate
          .evaluate(() => typeof window.lan?.call === "function")
          .catch(() => false)
      ) {
        hostPage = candidate;
        break;
      }
    }
    assert.ok(hostPage);
    await hostPage.evaluate(() => window.lan.call("hostStop"));
    await hostPage.locator("#local-password").fill(password);
    await hostPage
      .getByRole("button", { name: "设置固定密码", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await hostPage.evaluate(() => window.lan.call("state"))).host.access
            .passwordConfigured,
      )
      .toBe(true);
    const code = await hostPage.locator(".device-code").textContent();
    assert.match(code, /^\d{9}$/);
    await hostPage
      .getByRole("button", { name: "允许远程协助", exact: true })
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
    await hostPage.screenshot({
      path: path.join(output, "vm-integrated-host.png"),
    });
    console.log(
      "Integrated VM host ready; device password configured through actual UI.",
    );
    local = await launchTauri(
      path.resolve(
        process.argv[3] ||
          path.join(
            "release",
            `SolunaRemote-${require("../package.json").version}-windows-x64-portable`,
            "SolunaRemote.exe",
          ),
      ),
      profile,
    );
    page = local.page;
    const form = page.locator("#connect-form");
    await form.locator("#partner-code").fill(code);
    await form
      .locator("#partner-password")
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
    await form.locator("#partner-password").fill(password);
    await form.getByRole("button", { name: "连接", exact: true }).click();
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
    await hostPage.locator("#partner-code").fill("");
    await hostPage.locator("#partner-code").focus();
    const box = await hostPage.locator("#partner-code").boundingBox();
    const remoteTarget = await hostPage.evaluate((box) => {
      const input = document.querySelector("#partner-code");
      window.remoteMouseEvidence = false;
      const onPointer = (event) => {
        window.remoteMouseDetails = {
          x: event.clientX,
          y: event.clientY,
          id: event.target.id,
        };
        if (event.target.id === "partner-code") {
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
    const playerPid = await nativePlayerPid(local.launcher.pid);
    await nativeEvidence(
      playerPid,
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
    await expect(hostPage.locator("#partner-code")).toHaveValue("123456", {
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
