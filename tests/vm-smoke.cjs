const assert = require("node:assert/strict");
const { _electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseAddress } = require("../app/core/validation.cjs");

async function main() {
  const address = parseAddress(process.argv[2] || "172.22.98.13").address;
  const executablePath = path.resolve(
    "release",
    "win-unpacked",
    "SolunaRemote.exe",
  );
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "lan-live-vm-"));
  let electron;
  try {
    electron = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`],
    });
    const page = await electron.firstWindow();
    await page
      .locator(".heading-buttons")
      .getByRole("button", { name: "添加设备", exact: true })
      .click();
    const form = page.locator("#device-form");
    await form
      .getByLabel("设备名称", { exact: true })
      .fill("LIVE Windows test VM");
    await form.getByLabel("内网地址").fill(address);
    await form.getByRole("button", { name: "添加设备", exact: true }).click();
    await page
      .locator(".device-status-large")
      .filter({ hasText: /在线|离线/ })
      .waitFor();
    const state = await page.evaluate(() => window.lan.call("state"));
    assert.equal(state.engines.nativeAvailable, true);
    const device = state.devices.find((entry) => entry.address === address);
    assert.ok(device?.status);
    const screenshot = path.resolve("test-results", "live-vm-connectivity.png");
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    if (!device.status.online) {
      assert.equal(
        await page
          .getByRole("button", { name: "进入桌面", exact: true })
          .isDisabled(),
        true,
      );
      console.log(
        JSON.stringify(
          {
            fixture: false,
            target: address,
            packagedNativeEngineAvailable: true,
            online: false,
            error: device.status.error,
            screenshot,
            streamVerified: false,
            note: "The real packaged UI probed the real VM. Streaming is correctly blocked because Sunshine is unreachable; no disabled button was treated as a successful connection.",
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    // This command probes only; it never begins a new PIN request or controls a live desktop.
    console.log(
      JSON.stringify(
        {
          fixture: false,
          target: address,
          online: true,
          screenshot,
          streamVerified: false,
          note: "Discovery succeeded; PIN authorization and a live stream still require a separate test.",
        },
        null,
        2,
      ),
    );
  } finally {
    await electron?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
